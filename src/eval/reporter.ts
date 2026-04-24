/**
 * Reporter — terminal table + JSON file, and optional baseline diff.
 *
 * The terminal output is designed to be scannable at a glance:
 *   - Top block: headline numbers
 *   - Per-difficulty breakdown
 *   - The worst-performing queries (so you know where to look)
 *   - If a baseline was provided, a delta row per metric
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BenchReport, QueryResult } from "./types.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

export function printReport(report: BenchReport, baseline?: BenchReport): void {
  console.log();
  console.log(`${BOLD}━━━ NeuroMem Recall Benchmark ━━━${RESET}`);
  console.log(`${DIM}run_id:${RESET} ${report.run_id}`);
  console.log(`${DIM}dataset:${RESET} ${report.config.dataset_name} v${report.config.dataset_version}`);
  console.log(
    `${DIM}seeded:${RESET} ${report.config.seed_count}  ` +
      `${DIM}queries:${RESET} ${report.config.query_count}  ` +
      `${DIM}limit:${RESET} ${report.config.recall_limit}`,
  );
  console.log();

  // ─── Headline numbers ─────────────────────────────────────────
  const s = report.summary;
  const b = baseline?.summary;

  console.log(`${BOLD}Summary${RESET}`);
  printMetricRow("recall@5", s.recall_at_5, b?.recall_at_5);
  printMetricRow("recall@10", s.recall_at_10, b?.recall_at_10);
  printMetricRow("MRR", s.mrr, b?.mrr);
  printMetricRow("nDCG@10", s.ndcg_at_10, b?.ndcg_at_10);
  printLatencyRow("latency mean", s.latency_mean_ms, b?.latency_mean_ms);
  printLatencyRow("latency p50", s.latency_p50_ms, b?.latency_p50_ms);
  printLatencyRow("latency p95", s.latency_p95_ms, b?.latency_p95_ms);
  console.log();

  // ─── By difficulty ────────────────────────────────────────────
  const difficultyKeys = Object.keys(s.by_difficulty);
  if (difficultyKeys.length > 0) {
    console.log(`${BOLD}By difficulty${RESET}`);
    const header = `  ${pad("bucket", 12)}${pad("n", 5)}${pad("recall@5", 12)}${pad("recall@10", 12)}${pad("MRR", 8)}`;
    console.log(DIM + header + RESET);
    for (const key of ["easy", "medium", "hard", "unspecified"]) {
      const d = s.by_difficulty[key];
      if (!d) continue;
      console.log(
        `  ${pad(key, 12)}${pad(String(d.count), 5)}${pad(fmt(d.recall_at_5), 12)}${pad(fmt(d.recall_at_10), 12)}${pad(fmt(d.mrr), 8)}`,
      );
    }
    console.log();
  }

  // ─── Worst queries ────────────────────────────────────────────
  const sorted = [...report.per_query].sort(
    (a, b) => a.recall_at_10 - b.recall_at_10,
  );
  const worst = sorted.slice(0, 5).filter((q) => q.recall_at_10 < 1);
  if (worst.length > 0) {
    console.log(`${BOLD}Lowest-recall queries${RESET}`);
    for (const q of worst) {
      const bar = q.recall_at_10 === 0 ? RED : YELLOW;
      console.log(
        `  ${bar}${fmt(q.recall_at_10)}${RESET}  ${DIM}[${q.difficulty}]${RESET}  "${truncate(q.query_text, 70)}"`,
      );
      if (q.missed_ids.length > 0) {
        console.log(`    ${DIM}missed:${RESET} ${q.missed_ids.join(", ")}`);
      }
    }
    console.log();
  }

  if (baseline) {
    printBaselineVerdict(report, baseline);
  }
}

export function writeReport(report: BenchReport, outputPath: string): void {
  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`${DIM}report written to${RESET} ${outputPath}`);
}

export function loadReport(path: string): BenchReport {
  return JSON.parse(readFileSync(path, "utf-8")) as BenchReport;
}

// ─── Internals ──────────────────────────────────────────────────

function printMetricRow(
  label: string,
  value: number,
  baseline: number | undefined,
): void {
  const row = `  ${pad(label, 16)}${pad(fmt(value), 10)}`;
  if (baseline === undefined) {
    console.log(row);
    return;
  }
  const delta = value - baseline;
  const sign = delta >= 0 ? "+" : "";
  const color = delta > 0.005 ? GREEN : delta < -0.005 ? RED : DIM;
  console.log(
    `${row}${color}${sign}${fmt(delta)}${RESET} ${DIM}vs baseline ${fmt(baseline)}${RESET}`,
  );
}

function printLatencyRow(
  label: string,
  value: number,
  baseline: number | undefined,
): void {
  const row = `  ${pad(label, 16)}${pad(value.toFixed(1) + "ms", 10)}`;
  if (baseline === undefined) {
    console.log(row);
    return;
  }
  const delta = value - baseline;
  const sign = delta >= 0 ? "+" : "";
  // Latency regression is bad (slower), improvement is good (faster) — invert colors
  const color = delta < -1 ? GREEN : delta > 1 ? RED : DIM;
  console.log(
    `${row}${color}${sign}${delta.toFixed(1)}ms${RESET} ${DIM}vs baseline ${baseline.toFixed(1)}ms${RESET}`,
  );
}

function printBaselineVerdict(report: BenchReport, baseline: BenchReport): void {
  const deltaR5 = report.summary.recall_at_5 - baseline.summary.recall_at_5;
  const deltaR10 = report.summary.recall_at_10 - baseline.summary.recall_at_10;
  const deltaMrr = report.summary.mrr - baseline.summary.mrr;

  const regressed = [deltaR5, deltaR10, deltaMrr].some((d) => d < -0.02);
  const improved = [deltaR5, deltaR10, deltaMrr].some((d) => d > 0.02);

  if (regressed) {
    console.log(`${RED}${BOLD}✗ REGRESSION${RESET} vs baseline (>2pp drop on at least one metric)`);
  } else if (improved) {
    console.log(`${GREEN}${BOLD}✓ IMPROVEMENT${RESET} vs baseline`);
  } else {
    console.log(`${DIM}≈ within noise of baseline${RESET}`);
  }
  console.log();
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function fmt(n: number): string {
  return n.toFixed(3);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Returns true if the report regressed on any headline metric by more than `threshold` (default 2pp). */
export function hasRegression(
  report: BenchReport,
  baseline: BenchReport,
  threshold = 0.02,
): boolean {
  return (
    baseline.summary.recall_at_5 - report.summary.recall_at_5 > threshold ||
    baseline.summary.recall_at_10 - report.summary.recall_at_10 > threshold ||
    baseline.summary.mrr - report.summary.mrr > threshold
  );
}

// Helper to dodge an unused-variable lint on `QueryResult` import
// when the file is tree-shaken in future refactors.
export type _Q = QueryResult;
