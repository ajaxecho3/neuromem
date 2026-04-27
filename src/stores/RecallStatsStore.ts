/**
 * RecallStatsStore — per-recall metering that backs the "live tokens saved"
 * tiles in the MemoryBrowser UI.
 *
 * One row per /tools/recall call. MemoryManager records these fire-and-forget
 * so the hot path isn't slowed; if a row ever fails to land we log and move
 * on (metering must never block a user's query).
 *
 * Separate pool so heavy metering churn can't starve the episodic store's
 * connection budget. Postgres handles per-db connection pooling internally;
 * this is just about keeping semantic separation clean.
 */

import pg from "pg";
import { config } from "../utils/config.js";

const { Pool } = pg;

/** Row shape inserted by MemoryManager after every recall(). */
export interface RecallStatsRow {
  agent_id: string;
  total_memory_count: number;
  returned_memory_count: number;
  baseline_tokens: number;
  neuromem_tokens: number;
  encoding: string;
}

/** Aggregate the UI needs: totals or a rolling window. */
export interface RecallStatsAggregate {
  recall_count: number;
  baseline_tokens: number;
  neuromem_tokens: number;
  saved_tokens: number;
  /** saved / baseline, 0..1. 0 when baseline is 0 or no rows exist. */
  reduction_pct: number;
  /** Mean saved tokens per recall — the "flat line" for projections. */
  saved_mean: number;
  /** Mean NeuroMem tokens per recall — direct measurement of hot-path context cost. */
  neuromem_mean: number;
  /** Oldest row in the aggregate, handy for "since X" copy in the UI. */
  since: string | null;
}

const EMPTY_AGGREGATE: RecallStatsAggregate = {
  recall_count: 0,
  baseline_tokens: 0,
  neuromem_tokens: 0,
  saved_tokens: 0,
  reduction_pct: 0,
  saved_mean: 0,
  neuromem_mean: 0,
  since: null,
};

export class RecallStatsStore {
  private pool: pg.Pool;

  constructor() {
    this.pool = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.user,
      password: config.postgres.password,
      max: 4,
    });
  }

  /**
   * Idempotent schema creation. Duplicates the DDL in docker/postgres/init.sql
   * so already-running installs pick up the table without a manual migration
   * (the docker init script only runs on a fresh volume).
   */
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS recall_stats (
        id                     BIGSERIAL PRIMARY KEY,
        agent_id               TEXT NOT NULL,
        recalled_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        total_memory_count     INTEGER NOT NULL,
        returned_memory_count  INTEGER NOT NULL,
        baseline_tokens        INTEGER NOT NULL,
        neuromem_tokens        INTEGER NOT NULL,
        saved_tokens           INTEGER NOT NULL
                               GENERATED ALWAYS AS (baseline_tokens - neuromem_tokens) STORED,
        encoding               TEXT NOT NULL DEFAULT 'cl100k_base'
      );
      CREATE INDEX IF NOT EXISTS idx_recall_stats_agent_time
        ON recall_stats (agent_id, recalled_at DESC);
      CREATE INDEX IF NOT EXISTS idx_recall_stats_time
        ON recall_stats (recalled_at DESC);
    `);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Insert a metering row. Callers fire-and-forget — if we throw, the caller
   * is expected to swallow the error so user-facing recall() stays green.
   */
  async record(row: RecallStatsRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO recall_stats
         (agent_id, total_memory_count, returned_memory_count,
          baseline_tokens, neuromem_tokens, encoding)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        row.agent_id,
        row.total_memory_count,
        row.returned_memory_count,
        row.baseline_tokens,
        row.neuromem_tokens,
        row.encoding,
      ],
    );
  }

  /** Lifetime totals across every agent. */
  async getTotals(): Promise<RecallStatsAggregate> {
    const res = await this.pool.query<{
      recall_count: string;
      baseline_tokens: string | null;
      neuromem_tokens: string | null;
      saved_tokens: string | null;
      saved_mean: string | null;
      neuromem_mean: string | null;
      since: Date | null;
    }>(
      `SELECT
         COUNT(*)::bigint              AS recall_count,
         COALESCE(SUM(baseline_tokens), 0)::bigint AS baseline_tokens,
         COALESCE(SUM(neuromem_tokens), 0)::bigint AS neuromem_tokens,
         COALESCE(SUM(saved_tokens), 0)::bigint    AS saved_tokens,
         AVG(saved_tokens)             AS saved_mean,
         AVG(neuromem_tokens)          AS neuromem_mean,
         MIN(recalled_at)              AS since
       FROM recall_stats`,
    );
    return rowToAggregate(res.rows[0]);
  }

  /**
   * Aggregate rows more recent than `sinceIso`. Returns an empty aggregate if
   * no rows fall in the window.
   */
  async getWindow(sinceIso: string): Promise<RecallStatsAggregate> {
    const res = await this.pool.query<{
      recall_count: string;
      baseline_tokens: string | null;
      neuromem_tokens: string | null;
      saved_tokens: string | null;
      saved_mean: string | null;
      neuromem_mean: string | null;
      since: Date | null;
    }>(
      `SELECT
         COUNT(*)::bigint              AS recall_count,
         COALESCE(SUM(baseline_tokens), 0)::bigint AS baseline_tokens,
         COALESCE(SUM(neuromem_tokens), 0)::bigint AS neuromem_tokens,
         COALESCE(SUM(saved_tokens), 0)::bigint    AS saved_tokens,
         AVG(saved_tokens)             AS saved_mean,
         AVG(neuromem_tokens)          AS neuromem_mean,
         MIN(recalled_at)              AS since
       FROM recall_stats
       WHERE recalled_at >= $1`,
      [sinceIso],
    );
    return rowToAggregate(res.rows[0]);
  }
}

/** Coerce Postgres's string-encoded bigints and nullable AVG() into JS numbers. */
function rowToAggregate(row: {
  recall_count: string;
  baseline_tokens: string | null;
  neuromem_tokens: string | null;
  saved_tokens: string | null;
  saved_mean: string | null;
  neuromem_mean: string | null;
  since: Date | null;
}): RecallStatsAggregate {
  const count = Number(row.recall_count);
  if (count === 0) return EMPTY_AGGREGATE;

  const baseline = Number(row.baseline_tokens ?? 0);
  const neuromem = Number(row.neuromem_tokens ?? 0);
  const saved = Number(row.saved_tokens ?? 0);

  return {
    recall_count: count,
    baseline_tokens: baseline,
    neuromem_tokens: neuromem,
    saved_tokens: saved,
    reduction_pct: baseline === 0 ? 0 : saved / baseline,
    saved_mean: Number(row.saved_mean ?? 0),
    neuromem_mean: Number(row.neuromem_mean ?? 0),
    since: row.since ? new Date(row.since).toISOString() : null,
  };
}
