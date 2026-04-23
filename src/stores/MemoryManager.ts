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
import { MemoryRouter } from "../router/MemoryRouter.js";
import type { InnerThought } from "../cognition/InnerThought.js";
import { withRetention } from "../utils/retention.js";

export class MemoryManager {
  constructor(
    public episodic: EpisodicStore,
    public semantic: SemanticStore,
    public working: WorkingStore,
    public associations: AssociationStore,
    public router: MemoryRouter,
    public innerThought?: InnerThought,
  ) {}

  static async create(innerThought?: InnerThought): Promise<MemoryManager> {
    const episodic = new EpisodicStore();
    const semantic = new SemanticStore();
    const working = new WorkingStore();
    const associations = new AssociationStore();

    await episodic.init();
    await semantic.init();
    await working.init();
    await associations.init();

    return new MemoryManager(
      episodic,
      semantic,
      working,
      associations,
      new MemoryRouter(innerThought),
      innerThought,
    );
  }

  async close(): Promise<void> {
    await Promise.all([
      this.episodic.close(),
      this.working.close(),
      this.associations.close(),
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
    const searches: Promise<Memory[]>[] = [];

    if (requestedTypes.has("working")) {
      searches.push(this.working.recall(query));
    }
    if (
      requestedTypes.has("episodic") ||
      requestedTypes.has("affective") ||
      requestedTypes.has("shared")
    ) {
      searches.push(this.episodic.recall(query));
    }
    if (requestedTypes.has("semantic") || requestedTypes.has("procedural")) {
      searches.push(this.semantic.recall(query));
    }

    const results = (await Promise.all(searches)).flat();

    // Reinforce episodic memories that appear in results
    for (const m of results) {
      if (m.id.startsWith("epi_")) {
        this.episodic.reinforce(m.id).catch(() => {}); // fire-and-forget
      }
    }

    // Rank combined list by importance × recency
    const now = Date.now();
    const ranked = results
      .map((m) => {
        const age =
          (now - new Date(m.timestamp).getTime()) / (1000 * 60 * 60 * 24);
        const recency = Math.exp(-age * (m.decay_rate || 0.05));
        const score = m.importance * 0.6 + recency * 0.4;
        return { m, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, query.limit ?? 10)
      .map((x) => x.m);

    return {
      memories: ranked.map((m) => withRetention(m)),
      strategy: "hybrid",
      scanned: results.length,
    };
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
   * Returns a compact, ready-to-inject context string for LLM prompts.
   * Recalls top-N memories ranked by relevance and formats them as
   * a numbered list — dramatically reduces token usage vs. full history.
   */
  async buildContext(
    query: string,
    agent_id = "default",
    limit = 8,
  ): Promise<{ context: string; memories: Memory[]; token_estimate: number }> {
    const result = await this.recall({ query, agent_id, limit });
    const memories = result.memories;

    if (memories.length === 0) {
      return { context: "", memories: [], token_estimate: 0 };
    }

    const lines = memories.map((m, i) => {
      const typeLabel = m.type.toUpperCase();
      const tags = m.tags.length ? ` [${m.tags.slice(0, 3).join(", ")}]` : "";
      return `${i + 1}. [${typeLabel}${tags}] ${m.content}`;
    });

    const context = `### Relevant memory context\n${lines.join("\n")}`;
    // Rough token estimate: ~4 chars per token
    const token_estimate = Math.ceil(context.length / 4);

    return { context, memories, token_estimate };
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
