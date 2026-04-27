import { apiFetch } from "./client";

/**
 * Headline numbers summarized from the last benchmark run. Null when no run
 * with token accounting has been recorded yet (e.g. before the feature shipped,
 * or on a fresh install before `npm run bench`).
 */
export interface LatestBench {
  timestamp: string;
  run_id: string;
  dataset: string;
  query_count: number;
  baseline_total: number;
  neuromem_total: number;
  saved_total: number;
  reduction_pct: number;
  baseline_mean: number;
  neuromem_mean: number;
  saved_mean: number;
  encoding: string;
  estimated: boolean;
}

/**
 * Live token savings measured from real recall traffic. Mirror of
 * RecallStatsAggregate on the server. All counts are zero when no
 * recalls have happened in the aggregate's window yet.
 */
export interface SavingsAggregate {
  recall_count: number;
  baseline_tokens: number;
  neuromem_tokens: number;
  saved_tokens: number;
  reduction_pct: number;
  saved_mean: number;
  neuromem_mean: number;
  /** ISO timestamp of the oldest row in the aggregate. null when empty. */
  since: string | null;
}

export interface LiveSavings {
  totals: SavingsAggregate;
  window_24h: SavingsAggregate;
  window_7d: SavingsAggregate;
}

export interface StatsResponse {
  memory_count: number;
  tokens_stored: number;
  /** True when the server had to fall back to the chars/4 heuristic. */
  tokens_estimated: boolean;
  /** Active encoding for this process — "cl100k_base" | "o200k_base". */
  tokens_encoding: string;
  latest_bench: LatestBench | null;
  /**
   * Optional so the UI can handle the transition period where the client
   * bundle has been redeployed but the server hasn't restarted yet. Old
   * servers omit this field entirely.
   */
  live_savings?: LiveSavings;
}

/** Zero-valued aggregate used as a default when the server omits live_savings. */
export const EMPTY_SAVINGS_AGGREGATE: SavingsAggregate = {
  recall_count: 0,
  baseline_tokens: 0,
  neuromem_tokens: 0,
  saved_tokens: 0,
  reduction_pct: 0,
  saved_mean: 0,
  neuromem_mean: 0,
  since: null,
};

/** Same shape as LiveSavings but every window is empty. */
export const EMPTY_LIVE_SAVINGS: LiveSavings = {
  totals: EMPTY_SAVINGS_AGGREGATE,
  window_24h: EMPTY_SAVINGS_AGGREGATE,
  window_7d: EMPTY_SAVINGS_AGGREGATE,
};

export function getStats(): Promise<StatsResponse> {
  return apiFetch<StatsResponse>(`/stats`);
}
