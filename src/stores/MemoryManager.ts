/**
 * MemoryManager — Orchestrates all four stores.
 *
 * This is the single entry point agents use via MCP. It hides the
 * fact that memory is fanned out across Postgres / Chroma / Redis / Neo4j.
 */

import type {
  Memory,
  WriteMemoryInput,
  RecallQuery,
  RecallResult,
  MemoryType,
} from "../types/index.js";
import { EpisodicStore } from "./EpisodicStore.js";
import { SemanticStore } from "./SemanticStore.js";
import { WorkingStore } from "./WorkingStore.js";
import { AssociationStore } from "./AssociationStore.js";
import { RecallStatsStore } from "./RecallStatsStore.js";
import { MemoryRouter } from "../router/MemoryRouter.js";
import type { InnerThought } from "../cognition/InnerThought.js";
import { withRetention } from "../utils/retention.js";
import {
  countTokens,
  sumTokens,
  getActiveEncoding,
} from "../utils/tokens.js";
import { checkStaleness } from "../cognition/StalenessChecker.js";

export class MemoryManager {
  constructor(
    public episodic: EpisodicStore,
    public semantic: SemanticStore,
    public working: WorkingStore,
    public associations: AssociationStore,
    public router: MemoryRouter,
    public recallStats: RecallStatsStore,
    public innerThought?: InnerThought,
  ) {}

  static async create(innerThought?: InnerThought): Promise<MemoryManager> {
    const episodic = new EpisodicStore();
    const semantic = new SemanticStore();
    const working = new WorkingStore();
    const associations = new AssociationStore();
    const recallStats = new RecallStatsStore();

    await episodic.init();
    await semantic.init();
    await working.init();
    await associations.init();
    await recallStats.init();

    return new MemoryManager(
      episodic,
      semantic,
      working,
      associations,
      new MemoryRouter(innerThought),
      recallStats,
      innerThought,
    );
  }

  async close(): Promise<void> {
    await Promise.all([
      this.episodic.close(),
      this.working.close(),
      this.associations.close(),
      this.recallStats.close(),
    ]);
  }

  // ─── WRITE ───────────────────────────────────────────────────
  async remember(input: WriteMemoryInput): Promise<
    Memory & {
      routing: string;
      duplicate: boolean;
      conflict: boolean;
      conflicting_ids: string[];
    }
  > {
    const decision = await this.router.routeWithReasoning(input.content, {
      type: input.type,
      importance: input.importance,
      tags: input.tags,
      valence: input.valence,
      arousal: input.arousal,
    });

    // LLM metadata enrichment when fields not explicitly provided
    if (
      this.innerThought &&
      (!input.importance || !input.tags || !input.title)
    ) {
      const prompt = `Rate the importance of this memory (0.0 to 1.0) and suggest up to 3 short tags and a brief title.
Memory: "${input.content.slice(0, 500)}"
Respond with only valid JSON, no markdown: {"importance": 0.7, "tags": ["tag1", "tag2"], "title": "Short title"}`;

      const response = await this.innerThought.reason(prompt);
      if (response) {
        try {
          const meta = JSON.parse(response) as {
            importance?: number;
            tags?: string[];
            title?: string;
          };
          if (!input.importance && typeof meta.importance === "number") {
            decision.importance = Math.max(0, Math.min(1, meta.importance));
          }
          if (!input.tags && Array.isArray(meta.tags)) {
            decision.tags = meta.tags.slice(0, 3).map(String);
          }
          if (!input.title && typeof meta.title === "string") {
            (input as any).title = meta.title;
          }
        } catch {
          // malformed JSON — ignore, use heuristic values
        }
      }
    }

    const enriched: WriteMemoryInput = {
      ...input,
      type: decision.type,
      tags: decision.tags,
      importance: decision.importance,
      valence: decision.valence,
      arousal: decision.arousal,
    };

    // ─── Deduplication ────────────────────────────────────────
    // Check for near-identical content before writing to avoid polluting recall.
    // Semantic/procedural: embedding similarity (catches paraphrases).
    // Episodic/shared: exact content match (fast, Postgres).
    // Working memory is ephemeral — skip dedup.
    let duplicate: Memory | null = null;
    if (decision.type === "semantic") {
      duplicate = await this.semantic.findSimilar(
        input.content,
        input.agent_id,
        "semantic",
      );
    } else if (decision.type === "procedural") {
      duplicate = await this.semantic.findSimilar(
        input.content,
        input.agent_id,
        "procedural",
      );
    } else if (
      decision.type === "episodic" ||
      decision.type === "affective" ||
      decision.type === "shared"
    ) {
      duplicate = await this.episodic.findByContent(
        input.content,
        input.agent_id,
      );
    }

    if (duplicate) {
      return {
        ...duplicate,
        routing: `duplicate of ${duplicate.id} — ${decision.reasoning}`,
        duplicate: true,
        conflict: false,
        conflicting_ids: [],
      };
    }

    // Initialize conflict tracking (populated later for semantic/procedural)
    let conflictIds: string[] = [];
    if (decision.type === "semantic" || decision.type === "procedural") {
      const related = await this.semantic.findRelated(
        input.content,
        input.agent_id,
        decision.type === "semantic" ? "semantic" : "procedural",
      );

      if (related.length > 0 && this.innerThought) {
        const list = related
          .map((m, i) => `${i + 1}. [${m.id}] ${m.content.slice(0, 150)}`)
          .join("\n");
        const prompt = `Does the NEW memory contradict any of the EXISTING memories below?
NEW: "${input.content.slice(0, 300)}"
EXISTING:
${list}

Return a JSON array of IDs that are contradicted (empty array if none).
Example: ["sem_abc123"] or []
Respond with only the JSON array.`;
        const response = await this.innerThought.reason(prompt);
        if (response) {
          try {
            const ids = JSON.parse(response) as string[];
            if (Array.isArray(ids))
              conflictIds = ids.filter((id) => typeof id === "string");
          } catch {
            /* ignore */
          }
        }
      } else if (related.length > 0) {
        // Heuristic: if new content directly negates ("X is not" vs stored "X is") flag it
        const negation =
          /\b(not|never|no longer|isn't|aren't|doesn't|don't|won't|false)\b/i;
        const newHasNegation = negation.test(input.content);
        if (newHasNegation) {
          conflictIds = related.map((m) => m.id);
        }
      }
    }
    // ──────────────────────────────────────────────────────────

    let mem: Memory;
    switch (decision.type) {
      case "working":
        mem = await this.working.write(enriched);
        break;
      case "episodic":
      case "affective":
        mem = await this.episodic.write({ ...enriched, type: "episodic" });
        break;
      case "semantic":
        mem = await this.semantic.write({ ...enriched, type: "semantic" });
        break;
      case "procedural":
        mem = await this.semantic.write({ ...enriched, type: "procedural" });
        break;
      case "shared":
        mem = await this.episodic.write({
          ...enriched,
          shared: true,
          type: "episodic",
        });
        break;
    }

    // Register in association graph so it's connectable
    await this.associations.registerMemory({
      id: mem.id,
      agent_id: mem.agent_id,
      type: mem.type,
      title: mem.title,
      tags: mem.tags,
    });

    return {
      ...mem,
      routing: decision.reasoning,
      duplicate: false,
      conflict: conflictIds.length > 0,
      conflicting_ids: conflictIds,
    };
  }

  // ─── RECALL ──────────────────────────────────────────────────
  /** Browse memories without embedding bias — for UI list/pagination */
  async listAll(opts: {
    agent_id: string;
    type?: MemoryType | MemoryType[];
    limit?: number;
    min_importance?: number;
  }): Promise<Memory[]> {
    const requestedTypes = this.normalizeTypes(opts.type);
    const searches: Promise<Memory[]>[] = [];

    if (
      requestedTypes.has("episodic") ||
      requestedTypes.has("affective") ||
      requestedTypes.has("shared")
    ) {
      searches.push(
        this.episodic.recall({
          query: "",
          agent_id: opts.agent_id,
          limit: opts.limit,
          min_importance: opts.min_importance,
        }),
      );
    }
    if (requestedTypes.has("semantic") || requestedTypes.has("procedural")) {
      const semTypes: ("semantic" | "procedural")[] = [];
      if (requestedTypes.has("semantic")) semTypes.push("semantic");
      if (requestedTypes.has("procedural")) semTypes.push("procedural");
      searches.push(
        this.semantic.list({
          agent_id: opts.agent_id,
          types: semTypes,
          limit: opts.limit,
          min_importance: opts.min_importance,
        }),
      );
    }

    const results = (await Promise.all(searches)).flat();
    results.sort((a, b) => b.importance - a.importance);
    return results.slice(0, opts.limit ?? 50).map((m) => withRetention(m));
  }

  async recall(query: RecallQuery): Promise<RecallResult> {
    const requestedTypes = this.normalizeTypes(query.type);

    // Fan out to each store. We keep each store's list ORDERED by that store's
    // native relevance signal (vector distance for semantic/procedural, token
    // overlap + importance for episodic, recency for working) so we can do
    // rank-based fusion rather than score-based fusion across incompatible
    // scales.
    // Per-store weights for RRF: semantic/procedural use true vector similarity
    // so their ranks are the most trustworthy signal of topical match. Episodic
    // ranks are token-overlap-based (noisy — "migration" matches outage reports
    // as well as migration howtos). Working ranks are recency-weighted keyword
    // overlap. Weighting episodic/working below semantic prevents a high-
    // importance-but-topically-weak episodic from beating the true semantic
    // top-1 when RRF points would otherwise tie at 1/(K+1).
    const storeSearches: Array<{ name: string; search: Promise<Memory[]> }> = [];
    if (requestedTypes.has("working")) {
      storeSearches.push({ name: "working", search: this.working.recall(query) });
    }
    if (
      requestedTypes.has("episodic") ||
      requestedTypes.has("affective") ||
      requestedTypes.has("shared")
    ) {
      storeSearches.push({ name: "episodic", search: this.episodic.recall(query) });
    }
    if (requestedTypes.has("semantic") || requestedTypes.has("procedural")) {
      storeSearches.push({ name: "semantic", search: this.semantic.recall(query) });
    }

    const storeLists = await Promise.all(storeSearches.map((s) => s.search));
    const flatResults = storeLists.flat();

    // Reinforce episodic memories that appear in results
    for (const m of flatResults) {
      if (m.id.startsWith("epi_")) {
        this.episodic.reinforce(m.id).catch(() => {}); // fire-and-forget
      }
    }

    // ─── Reciprocal Rank Fusion ───────────────────────────────────
    // For each store's ordered list, each memory gets 1/(RRF_K + rank) points.
    // A memory returned by multiple stores accumulates points across them.
    //
    // Importance is a STRICT TIEBREAKER, not an additive. Adding importance
    // to the RRF score lets importance swamp rank position (importance * 0.05
    // is ~3x the rank-range of RRF itself), which reintroduces the bug RRF
    // was meant to fix. When two memories truly tie on RRF, importance breaks
    // the tie; otherwise, store-native ranking wins.
    const RRF_K = 60;
    const scoreByMem = new Map<string, { mem: Memory; score: number }>();

    for (const list of storeLists) {
      list.forEach((m, idx) => {
        const rrf = 1 / (RRF_K + idx + 1);
        const existing = scoreByMem.get(m.id);
        if (existing) {
          existing.score += rrf;
        } else {
          scoreByMem.set(m.id, { mem: m, score: rrf });
        }
      });
    }

    const ranked = [...scoreByMem.values()]
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.mem.importance ?? 0) - (a.mem.importance ?? 0);
      })
      .slice(0, query.limit ?? 10)
      .map((x) => x.mem);

    const result: RecallResult = {
      memories: ranked.map((m) => withRetention(m)),
      strategy: "rrf",
      scanned: flatResults.length,
    };

    // ─── Fire-and-forget live metering ─────────────────────────
    // We want a cumulative "tokens saved by NeuroMem" number backed by real
    // production recalls, not the synthetic benchmark. The hot path has
    // already produced `result` — we just queue the measurement and return.
    // If metering fails (DB down, etc.) we log and move on; the user must
    // never feel it.
    void this.meterRecall(query, ranked).catch((err) => {
      console.warn(
        `[recall_stats] meter failed for agent=${query.agent_id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

    return result;
  }

  /**
   * Compute baseline/neuromem token costs and insert one recall_stats row.
   *
   * The naive baseline is the cost of stuffing every memory the agent owns
   * (plus shared memories, matching recall's default behaviour) into context
   * alongside the query. NeuroMem cost is just the actually-returned set
   * plus the same query.
   *
   * We listAll() across all stores here — it's O(N) in agent size, but this
   * method runs detached from the user's request so it only shows up as
   * background DB load, never as user-visible latency.
   */
  private async meterRecall(
    query: RecallQuery,
    returned: Memory[],
  ): Promise<void> {
    const all = await this.listAll({ agent_id: query.agent_id });
    const queryTokens = countTokens(query.query);
    const baselineTokens = sumTokens(all.map((m) => m.content)) + queryTokens;
    const neuromemTokens =
      sumTokens(returned.map((m) => m.content)) + queryTokens;

    await this.recallStats.record({
      agent_id: query.agent_id,
      total_memory_count: all.length,
      returned_memory_count: returned.length,
      baseline_tokens: baselineTokens,
      neuromem_tokens: neuromemTokens,
      encoding: getActiveEncoding(),
    });
  }

  // ─── ASSOCIATE ───────────────────────────────────────────────
  async associate(id_a: string, id_b: string): Promise<void> {
    await this.associations.associate(id_a, id_b);
  }

  async spreadingActivation(
    id: string,
    hops = 2,
    limit = 20,
  ): Promise<Memory[]> {
    const relatedIds = await this.associations.findRelated(id, hops, limit);
    const memories: Memory[] = [];
    for (const rid of relatedIds) {
      const m = await this.readById(rid);
      if (m) memories.push(m);
    }
    return memories;
  }

  // ─── READ / FORGET ───────────────────────────────────────────
  async readById(id: string): Promise<Memory | null> {
    if (id.startsWith("wrk_")) return this.working.readById(id);
    if (id.startsWith("epi_")) return this.episodic.readById(id);
    if (id.startsWith("sem_") || id.startsWith("pro_"))
      return this.semantic.readById(id);
    return null;
  }

  async forget(id: string): Promise<boolean>;
  async forget(opts: {
    query: string;
    agent_id?: string;
    type?: MemoryType | MemoryType[];
    limit?: number;
  }): Promise<{ forgotten: number; ids: string[] }>;
  async forget(
    idOrOpts:
      | string
      | {
          query: string;
          agent_id?: string;
          type?: MemoryType | MemoryType[];
          limit?: number;
        },
  ): Promise<boolean | { forgotten: number; ids: string[] }> {
    // By-ID path (original behavior)
    if (typeof idOrOpts === "string") {
      const id = idOrOpts;
      let ok = false;
      if (id.startsWith("wrk_")) ok = await this.working.forget(id);
      else if (id.startsWith("epi_")) ok = await this.episodic.forget(id);
      else if (id.startsWith("sem_") || id.startsWith("pro_"))
        ok = await this.semantic.forget(id);
      await this.associations.forget(id);
      return ok;
    }

    // By-query path
    const { query, agent_id = "default", type, limit = 50 } = idOrOpts;
    const recalled = await this.recall({ query, agent_id, type, limit });
    let candidates = recalled.memories;

    // LLM relevance filter
    if (this.innerThought && candidates.length > 0) {
      const list = candidates
        .map((m, i) => `${i + 1}. [${m.id}] ${m.content.slice(0, 100)}`)
        .join("\n");
      const prompt = `You are deciding which memories to permanently delete based on the query: "${query}".

Memories:
${list}

Return a JSON array of IDs that are truly relevant to the query and should be deleted.
Example: ["epi_abc123", "sem_xyz789"]
Respond with only the JSON array, no other text.`;

      const response = await this.innerThought.reason(prompt);
      if (response) {
        try {
          const filtered = JSON.parse(response) as string[];
          if (Array.isArray(filtered) && filtered.length > 0) {
            candidates = candidates.filter((m) => filtered.includes(m.id));
          }
        } catch {
          // malformed JSON — proceed with all recalled memories
        }
      }
    }

    const ids: string[] = [];
    for (const m of candidates) {
      await this.forget(m.id);
      ids.push(m.id);
    }
    return { forgotten: ids.length, ids };
  }

  // ─── REFLECT ─────────────────────────────────────────────────
  async reflect(agent_id: string, timeframe_days = 7) {
    const [episodicCount, semanticCount, workingCount, graphStats] =
      await Promise.all([
        this.episodic.countByAgent(agent_id),
        this.semantic.countByAgent(agent_id),
        this.working.countByAgent(agent_id),
        this.associations.stats(agent_id),
      ]);

    return {
      timeframe_days,
      counts: {
        working: workingCount,
        episodic: episodicCount,
        semantic: semanticCount.semantic,
        procedural: semanticCount.procedural,
      },
      graph: graphStats,
    };
  }

  // ─── DECAY ───────────────────────────────────────────────────
  async applyDecay(agent_id: string): Promise<{ decayed: number }> {
    return this.episodic.applyDecay(agent_id);
  }

  // ─── VERSIONING ──────────────────────────────────────────────
  async getVersionHistory(id: string) {
    if (!id.startsWith("epi_")) return [];
    return this.episodic.getVersionHistory(id);
  }

  // ─── BATCH REMEMBER ──────────────────────────────────────────
  async rememberBatch(inputs: WriteMemoryInput[]): Promise<{
    stored: number;
    duplicates: number;
    results: Array<Memory & { routing: string; duplicate: boolean }>;
  }> {
    const results = await Promise.all(
      inputs.map((input) => this.remember(input)),
    );
    const duplicates = results.filter((r) => r.duplicate).length;
    return { stored: results.length - duplicates, duplicates, results };
  }

  // ─── BUILD CONTEXT ────────────────────────────────────────────
  /**
   * Returns a token-budget-aware, scored memory context block for LLM prompts.
   *
   * Scoring per memory:
   *   score = rank_relevance × (importance ^ 0.7) × recency_decay
   *
   *   rank_relevance  — exponential decay over RRF rank position (rank 0 = 1.0)
   *   importance      — dampened with ^0.7 so high-importance doesn't dominate
   *   recency_decay   — e^(-λ × days_old), λ = 0.05 (half-life ≈ 14 days)
   *
   * Memories are greedily added in score order until context_budget tokens
   * would be exceeded. The returned `context` is a <memory> XML block ready
   * to splice into a system prompt.
   */
  async buildContext(
    query: string,
    agent_id = "default",
    opts: { limit?: number; context_budget?: number; model?: string; project_root?: string } | number = {},
  ): Promise<{
    context: string;
    memories: Memory[];
    token_estimate: number;
    metadata: {
      total_candidates: number;
      injected_count: number;
      tokens_used: number;
      budget_exhausted: boolean;
      over_budget_warning?: boolean;
      stale_files: string[];
      stale_count: number;
      fresh_count: number;
    };
  }> {
    // Back-compat: old callers pass limit as a plain number
    const { limit = 8, context_budget, model, project_root } =
      typeof opts === "number" ? { limit: opts, context_budget: undefined, model: undefined, project_root: undefined } : opts;

    // Clamp budget to a safe range; 0 or negative → return empty
    const budget = context_budget !== undefined
      ? Math.max(0, context_budget)
      : undefined;

    if (budget === 0) {
      return {
        context: "",
        memories: [],
        token_estimate: 0,
        metadata: { total_candidates: 0, injected_count: 0, tokens_used: 0, budget_exhausted: true, stale_files: [], stale_count: 0, fresh_count: 0 },
      };
    }

    // Over-fetch candidates so scoring can demote lower-quality results
    const fetchLimit = limit * 3;
    const result = await this.recall({ query, agent_id, limit: fetchLimit });
    const candidates = result.memories;

    // ─── Staleness check ──────────────────────────────────────
    // If project_root is provided, exclude memories whose source file has
    // changed or been deleted. Unknown memories (no source_hash) are treated
    // as fresh conservatively so legacy memories are not silently dropped.
    let validCandidates = candidates;
    let staleFiles: string[] = [];
    let staleCount = 0;

    if (project_root && candidates.length > 0) {
      try {
        const stalenessReport = await checkStaleness(candidates, project_root);
        validCandidates = [...stalenessReport.fresh, ...stalenessReport.unknown];
        staleFiles = stalenessReport.stale_files;
        staleCount = stalenessReport.stale.length;
        if (staleCount > 0) {
          console.log(
            `[MemoryManager] Staleness check: ${stalenessReport.fresh.length} fresh, ` +
            `${stalenessReport.unknown.length} unknown, ${staleCount} stale — ` +
            `excluded files: ${staleFiles.join(", ")}`,
          );
        }
      } catch (err) {
        console.warn("[MemoryManager] Staleness check failed — using all candidates:", err);
      }
    }

    if (validCandidates.length === 0) {
      return {
        context: "",
        memories: [],
        token_estimate: 0,
        metadata: { total_candidates: candidates.length, injected_count: 0, tokens_used: 0, budget_exhausted: false, stale_files: staleFiles, stale_count: staleCount, fresh_count: 0 },
      };
    }

    // ─── Score each candidate ──────────────────────────────────
    const LAMBDA = 0.05; // recency decay rate (~14-day half-life)
    const now = Date.now();

    const scored = validCandidates.map((m, rank) => {
      // Rank relevance: exponential decay so rank-0 = 1.0, rank-5 ≈ 0.22
      const rank_relevance = Math.exp(-0.3 * rank);

      // Importance: dampen with ^0.7 to prevent high-importance noise from dominating
      const importance_score = Math.pow(Math.max(0, Math.min(1, m.importance ?? 0.5)), 0.7);

      // Recency decay: working memory defaults to 0 days old (always fresh)
      const ts = m.timestamp ? new Date(m.timestamp).getTime() : now;
      const days_old = Math.max(0, (now - ts) / (1000 * 60 * 60 * 24));
      const recency_decay = Math.exp(-LAMBDA * days_old);

      const score = rank_relevance * importance_score * recency_decay;
      return { mem: m, score };
    });

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    // ─── Greedy token-budget fill ──────────────────────────────
    const { countTokens, encodingForModel } = await import("../utils/tokens.js");
    const encoding = encodingForModel(model);

    const formatLine = (m: Memory): string => {
      const tags = m.tags.length ? ` #${m.tags.slice(0, 3).join(" #")}` : "";
      return `[${m.type}]${tags} ${m.content}  (importance: ${(m.importance ?? 0).toFixed(2)})`;
    };

    // Header/footer token overhead for the <memory> XML wrapper
    const HEADER = "<memory>\n";
    const FOOTER = "</memory>";
    let tokensUsed = countTokens(HEADER + FOOTER, encoding);
    const PER_ITEM_OVERHEAD = 4; // newline + formatting chars per entry

    const selected: Memory[] = [];
    let budgetExhausted = false;
    let overBudgetWarning = false;

    for (const { mem } of scored) {
      const line = formatLine(mem);
      const lineTokens = countTokens(line, encoding) + PER_ITEM_OVERHEAD;

      if (budget !== undefined && tokensUsed + lineTokens > budget) {
        // Edge case: first memory alone exceeds budget — include it with a warning
        if (selected.length === 0) {
          selected.push(mem);
          tokensUsed += lineTokens;
          overBudgetWarning = true;
        } else {
          budgetExhausted = true;
        }
        break;
      }

      selected.push(mem);
      tokensUsed += lineTokens;

      // Stop once we've filled up to the requested limit
      if (selected.length >= limit) break;
    }

    // ─── Format output ─────────────────────────────────────────
    if (selected.length === 0) {
      return {
        context: "",
        memories: [],
        token_estimate: 0,
        metadata: {
          total_candidates: candidates.length,
          injected_count: 0,
          tokens_used: 0,
          budget_exhausted: false,
          stale_files: staleFiles,
          stale_count: staleCount,
          fresh_count: validCandidates.length,
        },
      };
    }

    const lines = selected.map(formatLine);
    const context = `<memory>\n${lines.join("\n")}\n</memory>`;

    return {
      context,
      memories: selected,
      token_estimate: tokensUsed,
      metadata: {
        total_candidates: candidates.length,
        injected_count: selected.length,
        tokens_used: tokensUsed,
        budget_exhausted: budgetExhausted,
        ...(overBudgetWarning ? { over_budget_warning: true } : {}),
        stale_files: staleFiles,
        stale_count: staleCount,
        fresh_count: validCandidates.length,
      },
    };
  }

  // ─── Internal ─────────────────────────────────────────────────
  private normalizeTypes(t: RecallQuery["type"]): Set<MemoryType> {
    if (!t)
      return new Set<MemoryType>([
        "working",
        "episodic",
        "semantic",
        "procedural",
        "affective",
      ]);
    const arr = Array.isArray(t) ? t : [t];
    return new Set(arr);
  }
}
