/**
 * Benchmark types — shared across the eval harness.
 *
 * A dataset has two kinds of records: seed memories and queries.
 * Queries reference seed memories by their `bench_id` (a stable,
 * dataset-local identifier), not the database id. The runner assigns
 * database ids at seed time and maintains a bench_id → db_id map.
 */

import type { MemoryType, EmotionalValence } from "../types/index.js";

/** A memory to seed before running queries. */
export interface BenchMemory {
  /** Dataset-local id used inside `expected_ids`. Not the DB id. */
  bench_id: string;
  content: string;
  type?: MemoryType;
  title?: string;
  tags?: string[];
  importance?: number;
  valence?: EmotionalValence;
  arousal?: number;
  shared?: boolean;
}

/** A query to fire after seeding. */
export interface BenchQuery {
  bench_id: string;
  query: string;
  /** Bench ids (from BenchMemory.bench_id) expected to appear in results. */
  expected_ids: string[];
  type?: MemoryType | MemoryType[];
  limit?: number;
  min_importance?: number;
  tags?: string[];
  /** Difficulty label — purely for reporting, no effect on scoring. */
  difficulty?: "easy" | "medium" | "hard";
  description?: string;
}

export interface BenchDataset {
  meta: {
    name: string;
    version: string;
    description: string;
  };
  memories: BenchMemory[];
  queries: BenchQuery[];
}

export interface QueryResult {
  query_id: string;
  query_text: string;
  difficulty: string;
  expected_ids: string[];
  returned_ids: string[];
  recall_at_5: number;
  recall_at_10: number;
  reciprocal_rank: number;
  ndcg_at_10: number;
  latency_ms: number;
  /** IDs that were expected but not returned. */
  missed_ids: string[];
}

export interface BenchSummary {
  recall_at_5: number;
  recall_at_10: number;
  mrr: number;
  ndcg_at_10: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  latency_mean_ms: number;
  by_difficulty: Record<string, {
    count: number;
    recall_at_5: number;
    recall_at_10: number;
    mrr: number;
  }>;
}

export interface BenchReport {
  run_id: string;
  timestamp: string;
  config: {
    dataset_name: string;
    dataset_version: string;
    server_url: string;
    agent_id: string;
    seed_count: number;
    query_count: number;
    recall_limit: number;
  };
  summary: BenchSummary;
  per_query: QueryResult[];
}

export interface BenchRunOptions {
  dataset_path: string;
  server_url: string;
  /** If omitted, a fresh bench_<timestamp> id is generated per run. */
  agent_id?: string;
  /** Number of results to ask for in each recall. Default 10. */
  recall_limit?: number;
  /** Where to write the JSON report. */
  output_path?: string;
  /** Optional baseline JSON report for regression comparison. */
  baseline_path?: string;
  /** Suppress progress output during seeding. */
  quiet?: boolean;
}
