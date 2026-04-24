# NeuroMem Recall Benchmark

A lightweight harness for measuring how well NeuroMem recalls seeded memories. It talks to a running NeuroMem instance over HTTP, so it exercises the same `/tools/remember` and `/tools/recall` code paths a real agent uses.

Use it to:

- Establish a baseline before you change anything in retrieval.
- Measure the impact of changes to embeddings, ranking, routing, or consolidation.
- Catch regressions in CI (exit code 1 on >2pp drop in recall@5, recall@10, or MRR).

> Looking for end-to-end *product* claims — persistence across clients, portability across transports, and actual task uplift in an LLM? See the [proof suite](proof/README.md) (`npm run proof`).

## Quick start

```bash
# 1. Start the stack
npm run docker:up

# 2. Wait ~10s for services to come up, then run
npm run bench

# 3. Save the first run as a baseline
cp .bench/<timestamp>.json .bench/baseline.json

# 4. Change something, re-run, and compare
npm run bench -- --baseline .bench/baseline.json
```

A typical run takes under a minute against a local stack.

## Flags

| Flag | Default | Description |
| --- | --- | --- |
| `--dataset <path>` | `src/eval/datasets/starter.json` | JSON dataset to run |
| `--url <url>` | `http://localhost:3000` (or `NEUROMEM_URL`) | NeuroMem server base URL |
| `--agent <id>` | `bench_<timestamp>_<rand>` | Override the generated agent_id |
| `--limit <n>` | `10` | Recall limit |
| `--output <path>` | `.bench/<timestamp>.json` | Where to write the JSON report |
| `--baseline <path>` | — | Compare against a previous report |
| `--quiet` | off | Suppress progress output |

Exit codes: `0` OK, `1` regression vs baseline, `2` run failed.

## What it measures

For each query, the runner captures:

- **recall@5 / recall@10** — what fraction of expected memories surfaced in the top-K.
- **Reciprocal rank / MRR** — how high the first expected memory ranked.
- **nDCG@10** — rank-weighted quality (binary relevance; graded relevance is a future extension).
- **latency_ms** — wall-clock recall latency, measured client-side.

The summary aggregates these across all queries and bucketizes by difficulty (`easy` / `medium` / `hard`). Latency is reported as mean / p50 / p95.

## How runs stay isolated

Each run generates a fresh `bench_<timestamp>_<nanoid>` agent_id. Memories seeded under that ID don't bleed into other agents, and queries only recall from that agent (plus `shared: true` entries, if the dataset uses them). You can run the benchmark against a production-ish instance without touching real data.

No cleanup is performed. If you want to reclaim space, tear down the stack with `npm run docker:reset`.

## Dataset format

```jsonc
{
  "meta": {
    "name": "starter",
    "version": "1.0.0",
    "description": "..."
  },
  "memories": [
    {
      "bench_id": "m_sem_001",        // stable id used inside the dataset
      "content": "Alex is a staff engineer on the platform team.",
      "type": "semantic",
      "title": "Alex's role",
      "tags": ["team", "alex"],
      "importance": 0.7,
      "valence": 0.0,                  // optional, [-1, 1]
      "arousal": 0.3,                  // optional, [0, 1]
      "shared": false                  // optional
    }
  ],
  "queries": [
    {
      "bench_id": "q_001",
      "query": "Who is Alex?",
      "expected_ids": ["m_sem_001"],   // ordered list of bench_ids that should surface
      "difficulty": "easy",            // easy | medium | hard
      "type": "semantic",              // optional MemoryType filter
      "tags": ["team"],                // optional tag filter
      "min_importance": 0.5,           // optional importance floor
      "limit": 10                      // optional per-query override
    }
  ]
}
```

`bench_id` is dataset-local. The runner maps each `bench_id` to the DB id returned by `remember()`, then translates returned DB ids back to `bench_id`s before scoring. If the server returns ids that weren't seeded by this run, they're counted as misses and logged as strays.

## Interpreting the output

The terminal report is laid out in four blocks:

```
━━━ NeuroMem Recall Benchmark ━━━
run_id: bench_...
dataset: starter v1.0.0
seeded: 40  queries: 20  limit: 10

Summary
  recall@5        0.620
  recall@10       0.745
  MRR             0.548
  nDCG@10         0.601
  latency mean    78.4ms
  latency p50     65.0ms
  latency p95     184.2ms

By difficulty
  bucket      n    recall@5    recall@10   MRR
  easy        8    0.875       1.000       0.812
  medium      8    0.625       0.750       0.542
  hard        4    0.250       0.375       0.188

Lowest-recall queries
  0.000  [hard]  "What did we decide about caching?"
    missed: m_epi_003, m_sem_012
  ...
```

If you passed `--baseline`, each headline metric gets a `+/-Δ` annotation plus a final verdict:

- `✓ IMPROVEMENT` — any metric gained >2pp.
- `≈ within noise` — all deltas under 2pp.
- `✗ REGRESSION` — any metric dropped >2pp. Exit code 1.

## Writing a custom dataset

Drop a new JSON file anywhere and point `--dataset` at it. Recipes that work well:

- **Pin edge cases.** When you find a real query your agent fluffs, add the paraphrase and the expected memory. The benchmark becomes a living pin board.
- **Stratify difficulty.** Easy = keyword overlap; medium = paraphrase or one-hop reasoning; hard = multi-answer, vague query, or requires filtering (importance, tags, type).
- **Vary memory types.** Mix `semantic`, `episodic`, `procedural`, `working`, `affective`, and `shared` so you catch router + store regressions.
- **Keep datasets small.** 20–100 queries is enough to see signal while staying under a minute per run.

## Known limitations

- **Time-scoped queries not supported.** The write API stamps `timestamp = now()` unconditionally, so the dataset can't pre-position memories in the past. Skip `time_range` queries until the write path accepts a backdated timestamp.
- **Binary relevance only.** nDCG treats every expected id as equally relevant. Graded relevance (e.g., 3/2/1 for must-have / nice-to-have / context) is a natural next step — the scoring hook is already in `metrics.ts`.
- **Chroma settle time is a fudge factor.** The runner waits 800ms after seeding before querying. On slow machines you may need to bump `INDEX_SETTLE_MS` in `runner.ts`.
- **No per-type baseline yet.** By-difficulty is shown in the terminal; by-type aggregation is in the raw JSON but not in the printed table. Easy to add if you want it.

## Files

```
src/eval/
├── bench.ts         # CLI entry point
├── client.ts        # HTTP client for /tools/{remember,recall}
├── metrics.ts       # Pure functions: recall@k, RR, nDCG, percentile, mean
├── reporter.ts      # Terminal table + JSON writer + baseline diff
├── runner.ts        # Orchestrates seed → settle → query → aggregate
├── types.ts         # Dataset, query, report types
├── README.md        # You are here
└── datasets/
    └── starter.json # 40 memories, 20 queries across easy/medium/hard
```
