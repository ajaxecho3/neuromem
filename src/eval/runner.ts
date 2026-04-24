/**
 * Benchmark runner — the orchestrator.
 *
 * Flow per run:
 *   1. Health-check the server
 *   2. Generate a fresh agent_id (bench_<timestamp>_<rand>) so the
 *      run is isolated from real data and from previous runs.
 *   3. Seed every BenchMemory → capture bench_id → db_id map.
 *      Seeding is throttled to a small concurrency because remember()
 *      can hit the LLM and we want a fair throughput profile.
 *   4. Give Chroma a beat to index (configurable pause).
 *   5. Fire each BenchQuery. Map returned db_ids → bench_ids via the
 *      map. Anything that can't be mapped is counted as a miss.
 *   6. Aggregate per-query metrics into a summary report.
 */

import { readFileSync } from "node:fs";
import { nanoid } from "nanoid";
import { BenchClient } from "./client.js";
import {
  recallAtK,
  reciprocalRank,
  ndcgAtK,
  mean,
  percentile,
} from "./metrics.js";
import type {
  BenchDataset,
  BenchReport,
  BenchRunOptions,
  BenchSummary,
  QueryResult,
} from "./types.js";

const SEED_CONCURRENCY = 4;
const INDEX_SETTLE_MS = 800;

export async function runBenchmark(
  opts: BenchRunOptions,
): Promise<BenchReport> {
  const dataset = loadDataset(opts.dataset_path);
  const client = new BenchClient(opts.server_url);
  const agentId = opts.agent_id ?? `bench_${Date.now()}_${nanoid(6)}`;
  const recallLimit = opts.recall_limit ?? 10;
  const log = opts.quiet ? () => {} : console.log;

  log(`[bench] dataset:  ${dataset.meta.name} v${dataset.meta.version}`);
  log(`[bench] server:   ${opts.server_url}`);
  log(`[bench] agent_id: ${agentId}`);
  log(`[bench] seeding ${dataset.memories.length} memories...`);

  await client.health();

  // ─── Seed ─────────────────────────────────────────────────────
  const benchToDb = new Map<string, string>();
  const dbToBench = new Map<string, string>();

  let seeded = 0;
  await runWithConcurrency(dataset.memories, SEED_CONCURRENCY, async (mem) => {
    const { id } = await client.remember(mem, agentId);
    benchToDb.set(mem.bench_id, id);
    dbToBench.set(id, mem.bench_id);
    seeded++;
    if (seeded % 10 === 0) log(`  ${seeded}/${dataset.memories.length}`);
  });
  log(`[bench] seeded ${seeded} memories. letting indexes settle...`);
  await sleep(INDEX_SETTLE_MS);

  // ─── Query ────────────────────────────────────────────────────
  const perQuery: QueryResult[] = [];
  log(`[bench] running ${dataset.queries.length} queries...`);

  for (const q of dataset.queries) {
    const { memories, latencyMs } = await client.recall(q.query, agentId, {
      type: q.type,
      limit: q.limit ?? recallLimit,
      min_importance: q.min_importance,
      tags: q.tags,
    });

    const returnedBenchIds = memories
      .map((m) => dbToBench.get(m.id))
      .filter((v): v is string => typeof v === "string");
    const expectedSet = new Set(q.expected_ids);
    const missed = q.expected_ids.filter((id) => !returnedBenchIds.includes(id));

    const r5 = recallAtK(q.expected_ids, returnedBenchIds, 5);
    const r10 = recallAtK(q.expected_ids, returnedBenchIds, 10);
    const rr = reciprocalRank(q.expected_ids, returnedBenchIds);
    const nd = ndcgAtK(q.expected_ids, returnedBenchIds, 10);

    perQuery.push({
      query_id: q.bench_id,
      query_text: q.query,
      difficulty: q.difficulty ?? "unspecified",
      expected_ids: q.expected_ids,
      returned_ids: returnedBenchIds,
      recall_at_5: r5,
      recall_at_10: r10,
      reciprocal_rank: rr,
      ndcg_at_10: nd,
      latency_ms: round(latencyMs, 1),
      missed_ids: missed,
    });

    // Stray ids that returned but weren't in the seed map get logged quietly
    const strayCount = memories.length - returnedBenchIds.length;
    if (strayCount > 0) {
      log(
        `  ⚠ query ${q.bench_id}: ${strayCount} returned id(s) not in seed map (stale agent data?)`,
      );
    }
    // Suppress expectedSet "unused" lint — it's here for future graded-relevance use
    void expectedSet;
  }

  // ─── Aggregate ────────────────────────────────────────────────
  const summary = summarize(perQuery);

  return {
    run_id: `bench_${Date.now()}_${nanoid(6)}`,
    timestamp: new Date().toISOString(),
    config: {
      dataset_name: dataset.meta.name,
      dataset_version: dataset.meta.version,
      server_url: opts.server_url,
      agent_id: agentId,
      seed_count: dataset.memories.length,
      query_count: dataset.queries.length,
      recall_limit: recallLimit,
    },
    summary,
    per_query: perQuery,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function loadDataset(path: string): BenchDataset {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as BenchDataset;
  validateDataset(parsed, path);
  return parsed;
}

function validateDataset(ds: BenchDataset, path: string): void {
  if (!ds.memories?.length) {
    throw new Error(`${path}: dataset has no memories`);
  }
  if (!ds.queries?.length) {
    throw new Error(`${path}: dataset has no queries`);
  }
  const benchIds = new Set(ds.memories.map((m) => m.bench_id));
  if (benchIds.size !== ds.memories.length) {
    throw new Error(`${path}: duplicate bench_id in memories`);
  }
  for (const q of ds.queries) {
    for (const id of q.expected_ids) {
      if (!benchIds.has(id)) {
        throw new Error(
          `${path}: query ${q.bench_id} references unknown memory bench_id "${id}"`,
        );
      }
    }
  }
}

function summarize(results: QueryResult[]): BenchSummary {
  const r5 = results.map((r) => r.recall_at_5);
  const r10 = results.map((r) => r.recall_at_10);
  const rr = results.map((r) => r.reciprocal_rank);
  const nd = results.map((r) => r.ndcg_at_10);
  const lat = results.map((r) => r.latency_ms);

  const byDiff: BenchSummary["by_difficulty"] = {};
  for (const r of results) {
    const bucket = (byDiff[r.difficulty] ??= {
      count: 0,
      recall_at_5: 0,
      recall_at_10: 0,
      mrr: 0,
    });
    bucket.count++;
  }
  for (const key of Object.keys(byDiff)) {
    const subset = results.filter((r) => r.difficulty === key);
    byDiff[key]!.recall_at_5 = round(mean(subset.map((r) => r.recall_at_5)), 4);
    byDiff[key]!.recall_at_10 = round(
      mean(subset.map((r) => r.recall_at_10)),
      4,
    );
    byDiff[key]!.mrr = round(mean(subset.map((r) => r.reciprocal_rank)), 4);
  }

  return {
    recall_at_5: round(mean(r5), 4),
    recall_at_10: round(mean(r10), 4),
    mrr: round(mean(rr), 4),
    ndcg_at_10: round(mean(nd), 4),
    latency_mean_ms: round(mean(lat), 1),
    latency_p50_ms: round(percentile(lat, 50), 1),
    latency_p95_ms: round(percentile(lat, 95), 1),
    by_difficulty: byDiff,
  };
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (item === undefined) return;
          await fn(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function round(n: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}
