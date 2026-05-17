/**
 * EpisodicStore — Hippocampus analog (PostgreSQL)
 *
 * Stores events/experiences with timeline, importance, and affective
 * weighting. Supports keyword search via pg_trgm and tag filtering.
 */

import pg from "pg";
import { nanoid } from "nanoid";
import type { Memory, WriteMemoryInput, RecallQuery } from "../types/index.js";
import { config } from "../utils/config.js";
import { computeStability, computeRetention } from "../utils/retention.js";

const { Pool } = pg;

export class EpisodicStore {
  private pool: pg.Pool;

  constructor() {
    this.pool = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.user,
      password: config.postgres.password,
      max: 10,
    });
  }

  async init(): Promise<void> {
    // Ensure the agent exists
    await this.pool.query(
      `INSERT INTO agents (id, name) VALUES ('default', 'Default Agent')
       ON CONFLICT (id) DO NOTHING`,
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ensureAgent(agent_id: string, name?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO agents (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [agent_id, name ?? agent_id],
    );
  }

  async write(
    input: WriteMemoryInput & { type?: "episodic" | "affective" },
  ): Promise<Memory> {
    const id = `epi_${nanoid(10)}`;
    const now = new Date().toISOString();
    const title = input.title ?? deriveTitle(input.content);

    await this.ensureAgent(input.agent_id);

    const provenance = {
      ...(input.created_by ? { created_by: input.created_by } : {}),
      ...(input.session_id ? { session_id: input.session_id } : {}),
    };

    const res = await this.pool.query(
      `INSERT INTO episodic_memories
         (id, agent_id, title, content, occurred_at, importance, valence, arousal,
          tags, source, shared, metadata, source_file, source_hash, analyzed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        id,
        input.agent_id,
        title,
        input.content,
        now,
        clamp01(input.importance ?? 0.5),
        input.valence ?? "neutral",
        clamp01(input.arousal ?? 0.3),
        input.tags ?? [],
        input.source ?? null,
        input.shared ?? false,
        JSON.stringify(provenance),
        input.source_file ?? null,
        input.source_hash ?? null,
        input.analyzed_at ? new Date(input.analyzed_at) : null,
      ],
    );
    return rowToMemory(res.rows[0]);
  }

  async readById(id: string): Promise<Memory | null> {
    const res = await this.pool.query(
      `SELECT * FROM episodic_memories WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? rowToMemory(res.rows[0]) : null;
  }

  async recall(query: RecallQuery): Promise<Memory[]> {
    const limit = query.limit ?? 10;
    const params: any[] = [query.agent_id];
    let sql = `SELECT * FROM episodic_memories WHERE (agent_id = $1`;

    if (query.include_shared) {
      sql += ` OR shared = TRUE`;
    }
    sql += `)`;

    // Tokenize the query and match ANY token against content/title. The old
    // behaviour used `content ILIKE '%<full query>%'`, which only matched
    // literal substrings — paraphrased queries never matched. Token-level OR
    // matching lets "what caused the April outage" match a memory that
    // mentions "April" and "outage" even if the exact phrase isn't present.
    const tokens = tokenizeForRecall(query.query);
    if (tokens.length > 0) {
      const clauses: string[] = [];
      for (const tok of tokens) {
        params.push(`%${tok}%`);
        const placeholder = `$${params.length}`;
        clauses.push(
          `(content ILIKE ${placeholder} OR title ILIKE ${placeholder})`,
        );
      }
      sql += ` AND (${clauses.join(" OR ")})`;
    }
    if (query.min_importance !== undefined) {
      params.push(query.min_importance);
      sql += ` AND importance >= $${params.length}`;
    }
    if (query.tags?.length) {
      params.push(query.tags);
      sql += ` AND tags && $${params.length}`;
    }
    if (query.time_range?.from) {
      params.push(query.time_range.from);
      sql += ` AND occurred_at >= $${params.length}`;
    }
    if (query.time_range?.to) {
      params.push(query.time_range.to);
      sql += ` AND occurred_at <= $${params.length}`;
    }

    // Rank by number of matching tokens (most-overlap first), then by
    // importance/recency as tiebreakers. Without the per-token count the top
    // rows were whichever had the highest importance, regardless of how well
    // they actually matched the query.
    const matchCountSql = tokens.length
      ? "(" +
        tokens
          .map((_, i) => {
            // params already contain the %tok% placeholders from above; reuse them.
            const placeholderIndex = i + 2; // +1 for agent_id, +1 because 1-indexed
            return `((content ILIKE $${placeholderIndex})::int + (title ILIKE $${placeholderIndex})::int)`;
          })
          .join(" + ") +
        ")"
      : "(0)";

    sql += ` ORDER BY
      ${tokens.length > 0 ? `${matchCountSql} DESC,` : ""}
      (importance * 0.6 +
       (1.0 / (1.0 + EXTRACT(EPOCH FROM (now() - occurred_at)) / 86400.0)) * 0.4) DESC
      LIMIT ${limit}`;

    const res = await this.pool.query(sql, params);

    // Filter out weak matches. Token-OR matching returns rows that share ANY
    // token with the query — including high-frequency words like "database"
    // that appear across many unrelated memories. For the merged rank-1 slot
    // to mean "this memory is topically close", require at least ~30% token
    // overlap (or 2 tokens, whichever is less) when the query has multiple
    // tokens. Short queries skip the filter to preserve single-keyword probes.
    let rows = res.rows;
    if (tokens.length >= 3) {
      const minMatches = Math.max(2, Math.ceil(tokens.length * 0.3));
      const lowered = tokens.map((t) => t.toLowerCase());
      rows = rows.filter((r) => {
        const hay = `${r.content ?? ""}\n${r.title ?? ""}`.toLowerCase();
        let hits = 0;
        for (const tok of lowered) if (hay.includes(tok)) hits++;
        return hits >= minMatches;
      });
    }

    // Bump access counts
    for (const row of rows) {
      await this.pool.query(`SELECT touch_episodic($1)`, [row.id]);
    }

    return rows.map(rowToMemory);
  }

  async listForConsolidation(agent_id: string): Promise<Memory[]> {
    const res = await this.pool.query(
      `SELECT * FROM episodic_memories
       WHERE agent_id = $1 AND consolidation_level < 1
       ORDER BY occurred_at ASC
       LIMIT 500`,
      [agent_id],
    );
    return res.rows.map(rowToMemory);
  }

  async markConsolidated(id: string, level: number): Promise<void> {
    await this.pool.query(
      `UPDATE episodic_memories SET consolidation_level = $2 WHERE id = $1`,
      [id, clamp01(level)],
    );
  }

  async forget(id: string): Promise<boolean> {
    const res = await this.pool.query(
      `DELETE FROM episodic_memories WHERE id = $1`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Find an exact-content duplicate for a given agent. */
  async findByContent(
    content: string,
    agentId: string,
  ): Promise<Memory | null> {
    const res = await this.pool.query(
      `SELECT * FROM episodic_memories WHERE agent_id = $1 AND content = $2 LIMIT 1`,
      [agentId, content],
    );
    return res.rows[0] ? rowToMemory(res.rows[0]) : null;
  }

  /**
   * Reinforcement: boost importance when a memory is actively recalled.
   * Decay: reduce importance of memories not accessed recently.
   * Called by the consolidation pass or background cognition.
   */
  async applyDecay(agent_id: string): Promise<{ decayed: number }> {
    // Load all episodic memories for this agent
    const res = await this.pool.query(
      `SELECT * FROM episodic_memories WHERE agent_id = $1 AND importance > 0`,
      [agent_id],
    );
    if (res.rows.length === 0) return { decayed: 0 };

    const now = Date.now();
    let decayed = 0;

    for (const row of res.rows) {
      const m = rowToMemory(row);
      const lastAccessed = m.last_accessed ?? m.timestamp;
      const daysSince =
        (now - new Date(lastAccessed).getTime()) / (1000 * 60 * 60 * 24);

      // Only apply decay if not accessed in the last 7 days
      if (daysSince < 7) continue;

      const stability = computeStability(
        m.importance,
        m.access_count,
        m.consolidation_level,
      );
      const retention = computeRetention(stability, daysSince);
      const newImportance = m.importance * retention;

      if (Math.abs(newImportance - m.importance) < 0.001) continue;

      await this.pool.query(
        `UPDATE episodic_memories SET importance = $1 WHERE id = $2`,
        [Math.max(0, newImportance), m.id],
      );
      decayed++;
    }

    return { decayed };
  }

  /**
   * Reinforcement: raise importance of a memory when recalled.
   * Cap at 1.0. The boost is small (0.05) to avoid runaway scores.
   */
  async reinforce(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE episodic_memories
       SET importance = LEAST(1.0, importance + 0.05),
           access_count = access_count + 1,
           last_accessed = now()
       WHERE id = $1`,
      [id],
    );
  }

  async countByAgent(agent_id: string): Promise<number> {
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS c FROM episodic_memories WHERE agent_id = $1`,
      [agent_id],
    );
    return res.rows[0].c;
  }

  async logConsolidation(
    agent_id: string,
    report: {
      processed: number;
      consolidated: number;
      forgotten: number;
      new_semantic: number;
      new_skills: number;
    },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO consolidation_runs
         (agent_id, completed_at, processed_count, consolidated_count,
          forgotten_count, new_semantic_count, new_skills_count, report)
       VALUES ($1, now(), $2, $3, $4, $5, $6, $7)`,
      [
        agent_id,
        report.processed,
        report.consolidated,
        report.forgotten,
        report.new_semantic,
        report.new_skills,
        JSON.stringify(report),
      ],
    );
  }

  async listAgents(): Promise<string[]> {
    const res = await this.pool.query(`SELECT id FROM agents ORDER BY id`);
    return res.rows.map((r: any) => r.id as string);
  }

  /**
   * Archive the current version of a memory before updating/replacing it.
   * Call this BEFORE modifying a memory to preserve history.
   */
  async archiveVersion(
    id: string,
    reason: "update" | "conflict_replace" = "update",
  ): Promise<void> {
    const mem = await this.readById(id);
    if (!mem) return;

    // Get next version number
    const vRes = await this.pool.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM memory_versions WHERE memory_id = $1`,
      [id],
    );
    const version = vRes.rows[0].next_version as number;

    await this.pool.query(
      `INSERT INTO memory_versions (memory_id, agent_id, version, content, title, importance, tags, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        mem.agent_id,
        version,
        mem.content,
        mem.title,
        mem.importance,
        mem.tags,
        reason,
      ],
    );
  }

  /** Retrieve the full version history for a memory, newest first. */
  async getVersionHistory(id: string): Promise<
    Array<{
      version: number;
      content: string;
      title: string;
      importance: number;
      tags: string[];
      archived_at: string;
      reason: string | null;
    }>
  > {
    const res = await this.pool.query(
      `SELECT version, content, title, importance, tags, archived_at, reason
       FROM memory_versions WHERE memory_id = $1 ORDER BY version DESC`,
      [id],
    );
    return res.rows.map((r: any) => ({
      version: r.version,
      content: r.content,
      title: r.title,
      importance: r.importance,
      tags: r.tags,
      archived_at: r.archived_at,
      reason: r.reason,
    }));
  }

  async update(
    id: string,
    patch: {
      importance?: number;
      tags?: string[];
      title?: string;
      content?: string;
    },
  ): Promise<void> {
    // Archive current version before modifying
    await this.archiveVersion(id, "update");

    const sets: string[] = [];
    const params: unknown[] = [id];
    if (patch.importance !== undefined) {
      params.push(patch.importance);
      sets.push(`importance = $${params.length}`);
    }
    if (patch.tags !== undefined) {
      params.push(patch.tags);
      sets.push(`tags = $${params.length}`);
    }
    if (patch.title !== undefined) {
      params.push(patch.title);
      sets.push(`title = $${params.length}`);
    }
    if (patch.content !== undefined) {
      params.push(patch.content);
      sets.push(`content = $${params.length}`);
    }
    if (sets.length === 0) return;
    await this.pool.query(
      `UPDATE episodic_memories SET ${sets.join(", ")} WHERE id = $1`,
      params,
    );
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function rowToMemory(row: any): Memory {
  return {
    id: row.id,
    type: row.shared ? "shared" : "episodic",
    agent_id: row.agent_id,
    title: row.title,
    content: row.content,
    timestamp: new Date(row.occurred_at).toISOString(),
    last_accessed: row.last_accessed
      ? new Date(row.last_accessed).toISOString()
      : undefined,
    access_count: row.access_count,
    importance: parseFloat(row.importance),
    valence: row.valence,
    arousal: parseFloat(row.arousal),
    consolidation_level: parseFloat(row.consolidation_level),
    decay_rate: parseFloat(row.decay_rate),
    tags: row.tags ?? [],
    source: row.source ?? undefined,
    shared: row.shared,
    source_file: row.source_file ?? undefined,
    source_hash: row.source_hash ?? undefined,
    analyzed_at: row.analyzed_at
      ? new Date(row.analyzed_at).toISOString()
      : undefined,
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function deriveTitle(content: string): string {
  const first = content.trim().split("\n")[0] ?? "untitled";
  return first.replace(/^#+\s*/, "").slice(0, 80);
}

/**
 * Break a natural-language query into recall-useful tokens.
 * - Lowercases
 * - Drops non-alphanumeric
 * - Drops short (<3 char) words
 * - Drops a small set of English stop words that show up in every query
 * - Dedupes
 * Returns [] for empty / all-stop-word queries so recall falls back to
 * importance/recency ordering.
 */
const RECALL_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "had",
  "was",
  "are",
  "our",
  "has",
  "have",
  "how",
  "its",
  "new",
  "now",
  "did",
  "use",
  "that",
  "this",
  "with",
  "from",
  "they",
  "will",
  "been",
  "were",
  "what",
  "which",
  "when",
  "where",
  "why",
  "who",
  "whom",
  "whose",
  "about",
  "into",
  "onto",
  "out",
  "off",
  "over",
  "under",
  "down",
  "than",
  "then",
  "else",
  "some",
  "any",
  "each",
  "every",
  "many",
  "much",
  "more",
  "most",
  "just",
  "very",
  "really",
  "still",
  "also",
  "too",
  "very",
  "well",
  "get",
  "got",
  "give",
  "gave",
  "make",
  "made",
  "take",
  "took",
  "look",
  "see",
  "saw",
  "know",
  "knew",
  "think",
  "thought",
  "tell",
  "told",
  "say",
  "said",
  "call",
  "go",
  "went",
  "come",
  "came",
  "want",
  "need",
  "put",
  "let",
  "been",
  "being",
  "is",
  "am",
  "be",
  "do",
  "does",
  "doing",
  "done",
]);

function tokenizeForRecall(raw?: string): string[] {
  if (!raw) return [];
  const tokens = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !RECALL_STOP_WORDS.has(t));
  return [...new Set(tokens)];
}
