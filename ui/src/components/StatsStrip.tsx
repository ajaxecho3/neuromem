import { useQuery } from "@tanstack/react-query";
import { getStats, EMPTY_LIVE_SAVINGS } from "../api/stats";

/**
 * Compact stats row shown above the MemoryBrowser filters.
 *
 * The tiles report NeuroMem's real-world value from live recall_stats:
 *   - Memories stored             (inventory)
 *   - Tokens stored               (inventory, token-priced)
 *   - Tokens saved (lifetime)     (cumulative value delivered)
 *   - Context reduction (24h)     (current efficiency — 24h rolling)
 *
 * When live metering hasn't produced any rows yet (fresh install, no
 * recalls run), the last two tiles collapse into a single "no recalls yet"
 * hint. The last-bench numbers are kept as a smaller subtitle under the
 * cumulative tile for regression context.
 */
export function StatsStrip() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["stats"],
    queryFn: getStats,
    // Live savings update every recall, so keep the window short.
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  if (isLoading) {
    return (
      <div className="mb-4 h-[60px] rounded-lg border border-border bg-card/40 animate-pulse" />
    );
  }
  if (error || !data) return null;

  const {
    memory_count,
    tokens_stored,
    tokens_estimated,
    tokens_encoding,
    latest_bench,
  } = data;

  // Server predates the live-savings release — fall back to empty windows
  // so the tiles render a "No recalls yet" message instead of crashing.
  const live_savings = data.live_savings ?? EMPTY_LIVE_SAVINGS;
  const totals = live_savings.totals;
  const window24 = live_savings.window_24h;
  const hasLiveData = totals.recall_count > 0;

  return (
    <div className="mb-4 grid grid-cols-2 sm:grid-cols-4 gap-px rounded-lg overflow-hidden border border-border bg-border">
      <Tile
        label="Memories stored"
        value={formatInt(memory_count)}
        hint="Across every agent"
      />
      <Tile
        label="Tokens stored"
        value={formatCompact(tokens_stored)}
        hint={tokens_estimated ? "Estimated (chars ÷ 4)" : tokens_encoding}
      />
      {hasLiveData ? (
        <>
          <Tile
            label="Tokens saved (lifetime)"
            value={formatCompact(totals.saved_tokens)}
            hint={`${formatInt(totals.recall_count)} recalls · avg ${formatCompact(totals.saved_mean)}/recall${latest_bench ? ` · bench ${(latest_bench.reduction_pct * 100).toFixed(1)}%` : ""}`}
            accent={totals.saved_tokens > 0 ? "positive" : "neutral"}
          />
          <Tile
            label="Reduction (24h)"
            value={
              window24.recall_count > 0
                ? `${(window24.reduction_pct * 100).toFixed(1)}%`
                : "—"
            }
            hint={
              window24.recall_count > 0
                ? `${formatInt(window24.recall_count)} recalls · saved ${formatCompact(window24.saved_tokens)} (${formatCompact(window24.baseline_tokens)} → ${formatCompact(window24.neuromem_tokens)})`
                : "No recalls in the last 24h"
            }
            accent={window24.reduction_pct > 0 ? "positive" : "neutral"}
          />
        </>
      ) : (
        <div className="col-span-2 bg-card p-3 flex flex-col justify-center">
          <div className="text-xs text-muted-foreground mb-0.5">
            Tokens saved (live)
          </div>
          <div className="text-sm text-muted-foreground">
            {latest_bench
              ? `No recalls yet. Last bench saved ${formatCompact(latest_bench.saved_total)} tokens (${(latest_bench.reduction_pct * 100).toFixed(1)}% reduction).`
              : "Fire a recall or run npm run bench to see savings."}
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  accent = "neutral",
}: {
  label: string;
  value: string;
  hint: string;
  accent?: "positive" | "neutral";
}) {
  const valueColor =
    accent === "positive"
      ? "text-emerald-500 dark:text-emerald-400"
      : "text-foreground";
  return (
    <div
      className="bg-card p-3 flex flex-col justify-center"
      title={hint}
    >
      <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
      <div className={`font-display text-xl ${valueColor}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
        {hint}
      </div>
    </div>
  );
}

function formatInt(n: number): string {
  return n.toLocaleString();
}

/** 1234 → "1.2k", 2_300_000 → "2.3M". Keeps tiles narrow on mobile. */
function formatCompact(n: number): string {
  if (n < 1_000) return Math.round(n).toLocaleString();
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}
