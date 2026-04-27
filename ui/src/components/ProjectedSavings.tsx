import { useQuery } from "@tanstack/react-query";
import { getStats, EMPTY_LIVE_SAVINGS } from "../api/stats";

/**
 * "Projected savings at scale" card.
 *
 * Answers the question a stakeholder will ask the moment they see the
 * StatsStrip: "cool, but how does this grow as my agent accumulates more
 * memories?"
 *
 * We extrapolate from two numbers:
 *   - avg_memory_tokens = tokens_stored / memory_count (from /api/ui/stats)
 *   - per_query_cost    = latest_bench.neuromem_mean  (measured)
 *                        OR  DEFAULT_RECALL_LIMIT × avg_memory_tokens
 *                           + a small query-text allowance (estimated)
 *
 * At each hypothetical scale N we project the naive baseline = N × avg,
 * subtract the NeuroMem per-query cost (which stays ~flat), and show the
 * resulting savings plus the context-window fit. The Claude 200K window is
 * our reference ceiling — it's the threshold past which "stuff everything
 * in" stops being a price concern and becomes literally impossible.
 *
 * When no benchmark has run yet we still render the card with estimated
 * numbers so users aren't staring at a blank slot — they get the shape of
 * the win right away and can sharpen it later with `npm run bench`.
 */
const CONTEXT_WINDOW_TOKENS = 200_000; // Claude's current main window
const PROJECTION_POINTS = [
  { label: "1K", count: 1_000 },
  { label: "10K", count: 10_000 },
  { label: "100K", count: 100_000 },
  { label: "1M", count: 1_000_000 },
];
/** Matches the server-side default in src/eval/runner.ts and BenchRunOptions. */
const DEFAULT_RECALL_LIMIT = 10;
/** Conservative allowance for the user-facing query string appended to the recall payload. */
const QUERY_TOKEN_ALLOWANCE = 20;

export function ProjectedSavings() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["stats"],
    queryFn: getStats,
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="mb-4 h-[130px] rounded-lg border border-border bg-card/40 animate-pulse" />
    );
  }
  if (error || !data) return null;

  // Need at least one memory to estimate the avg memory size. Without any
  // memories the projection is literally division by zero.
  if (data.memory_count === 0) {
    return null;
  }

  const avgMemTokens = data.tokens_stored / data.memory_count;
  // Gracefully handle an old server that doesn't return the live_savings
  // field yet — treat it as "no live data" and fall through to bench/estimate.
  const live_savings = data.live_savings ?? EMPTY_LIVE_SAVINGS;
  // Prefer live production recalls (most honest signal), fall back to the
  // benchmark (controlled proxy), then to a default-recall-limit estimate
  // (the crudest but still-useful projection).
  const liveMean =
    live_savings.totals.recall_count > 0
      ? live_savings.totals.neuromem_mean
      : null;
  const benchMean = data.latest_bench?.neuromem_mean ?? null;
  const estimatedPerQuery =
    DEFAULT_RECALL_LIMIT * avgMemTokens + QUERY_TOKEN_ALLOWANCE;

  const perQueryCost = liveMean ?? benchMean ?? estimatedPerQuery;
  const source: "live" | "bench" | "estimate" =
    liveMean !== null ? "live" : benchMean !== null ? "bench" : "estimate";

  return (
    <div className="mb-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-1">
        <h2 className="font-display text-sm text-foreground flex items-center gap-2">
          Projected savings at scale
          <SourceBadge source={source} />
        </h2>
        <span className="text-[11px] text-muted-foreground">
          avg {formatInt(avgMemTokens)} tokens/memory · NeuroMem sends{" "}
          {source === "estimate" ? "~" : ""}
          {formatInt(perQueryCost)} tokens/query regardless of store size
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {PROJECTION_POINTS.map((point) => {
          const baseline = point.count * avgMemTokens;
          const saved = Math.max(0, baseline - perQueryCost);
          const reduction = baseline === 0 ? 0 : saved / baseline;
          const windowPct = baseline / CONTEXT_WINDOW_TOKENS;
          const overflow = baseline > CONTEXT_WINDOW_TOKENS;

          return (
            <div
              key={point.label}
              className="rounded-md border border-border/70 p-3"
            >
              <div className="flex items-baseline justify-between mb-1">
                <div className="font-ibm-mono text-xs text-muted-foreground">
                  at {point.label} memories
                </div>
                <div
                  className={`font-display text-lg ${
                    reduction > 0
                      ? "text-emerald-500 dark:text-emerald-400"
                      : "text-foreground"
                  }`}
                >
                  {(reduction * 100).toFixed(reduction >= 0.99 ? 2 : 1)}%
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                saves{" "}
                <span className="text-foreground font-medium">
                  {formatCompact(saved)}
                </span>{" "}
                tokens/query
              </div>
              <div
                className={`text-[11px] mt-1 ${
                  overflow
                    ? "text-red-500 dark:text-red-400"
                    : "text-muted-foreground"
                }`}
                // The tooltip spells out what baseline/window actually mean
                // so hovering the line is enough to decode the jargon.
                title={
                  overflow
                    ? `At this scale, stuffing every memory into the prompt would need ${formatInt(baseline)} tokens — ${formatInt(baseline - CONTEXT_WINDOW_TOKENS)} more than Claude's 200K context limit. The request wouldn't be accepted at all. NeuroMem sends ~${formatInt(perQueryCost)} tokens, which does fit.`
                    : `Stuffing every memory into the prompt would need ${formatInt(baseline)} tokens, which fits inside Claude's 200K context window. NeuroMem sends ~${formatInt(perQueryCost)} tokens instead.`
                }
              >
                {overflow ? (
                  <>
                    ✗ won't fit in a 200K LLM call without NeuroMem (short by{" "}
                    {formatCompact(baseline - CONTEXT_WINDOW_TOKENS)} tokens)
                  </>
                ) : (
                  <>
                    fits in a 200K LLM call, using{" "}
                    {(windowPct * 100).toFixed(windowPct < 0.1 ? 2 : 1)}% of it
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground mt-3">
        {source === "live" ? (
          <>
            Per-query cost measured from real production recalls (
            {formatInt(live_savings.totals.recall_count)} so far).{" "}
          </>
        ) : source === "bench" ? (
          <>
            Per-query cost measured from the newest benchmark. Fire a real
            recall to start replacing this with live traffic numbers.{" "}
          </>
        ) : (
          <>
            Per-query cost is estimated from the default recall limit (
            {DEFAULT_RECALL_LIMIT}) × your avg memory size. Run{" "}
            <code className="font-ibm-mono bg-muted px-1 py-0.5 rounded">
              npm run bench
            </code>{" "}
            or fire a live recall to sharpen this number.{" "}
          </>
        )}
        Projections assume the avg memory size stays constant and per-query
        recall cost stays flat as the store grows. When the naive baseline
        overflows the context window, NeuroMem stops being a cost optimization
        and becomes the only way the call can happen at all.
      </p>
    </div>
  );
}

/**
 * Small pill next to the card title showing where the per-query cost number
 * came from. "live" → no badge (we're showing the most trustworthy signal —
 * no need to flag it). "bench" and "estimate" get labeled so the user knows
 * the caveats before sharing the numbers.
 */
function SourceBadge({ source }: { source: "live" | "bench" | "estimate" }) {
  if (source === "live") return null;
  if (source === "bench") {
    return (
      <span
        className="text-[10px] font-normal uppercase tracking-wide text-sky-500 dark:text-sky-400 border border-sky-500/40 rounded-full px-1.5 py-0.5"
        title="Per-query cost comes from the newest benchmark run, not live traffic yet."
      >
        from bench
      </span>
    );
  }
  return (
    <span
      className="text-[10px] font-normal uppercase tracking-wide text-amber-500 dark:text-amber-400 border border-amber-500/40 rounded-full px-1.5 py-0.5"
      title="No benchmark or live recalls yet — per-query cost is estimated from the default recall limit."
    >
      estimated
    </span>
  );
}

function formatInt(n: number): string {
  return Math.round(n).toLocaleString();
}

function formatCompact(n: number): string {
  if (n < 1_000) return Math.round(n).toLocaleString();
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}
