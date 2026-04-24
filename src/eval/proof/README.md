# NeuroMem — Proof Suite

Three experiments that answer three different questions about whether
this project actually does what it claims. The benchmark (`src/eval/bench.ts`)
measures *retrieval quality*; the proof suite measures *product claims*.

| Experiment | File | Claim under test |
|---|---|---|
| Persistence | [`persistence.ts`](persistence.ts) | Memories written by one client survive the jump to a brand-new client (optionally across a server restart). |
| Cross-harness portability | [`cross-harness.ts`](cross-harness.ts) | A memory written over one transport (HTTP REST) is recallable over a *different* transport (MCP Streamable HTTP). |
| Task utility | [`task-eval.ts`](task-eval.ts) | An LLM that cannot answer a question cold gets it right once NeuroMem injects the relevant memories as context. |

Each script is standalone, exits non-zero on failure, and writes a
timestamped JSON artifact under `.bench/proof/`. A wrapper
([`run-all.ts`](run-all.ts)) runs all three and emits a single Markdown
report at `.bench/proof/report.md` you can paste into a PR or share.

## Quick start

Bring the stack up:

```bash
npm run docker:up            # postgres, redis, chroma, neo4j, neuromem
```

Run every proof with the defaults (persistence + cross-harness + task
utility with the keyword judge — no LLM setup required):

```bash
npm run proof
```

Individual experiments:

```bash
npm run proof:persist
npm run proof:xharness
npm run proof:tasks
```

Exit code is `0` only when **every** experiment passes its threshold.

### First-run gotchas

- **Ollama is the default answerer for the task proof.** If you don't have a
  local Ollama running with the model pulled, the script now fails fast with
  a clear hint (`ollama pull llama3.2`). If you want to run the full suite
  without any LLM setup, use `npm run proof -- --skip-tasks` or
  `npm run proof:tasks -- --answerer mock`.
- **Persistence and cross-harness use long content-prefix queries** (120
  chars) so the target memory reliably lands in the top-K. This keeps the
  proof focused on *existence*; retrieval quality is the benchmark's job
  (`npm run bench`).

## Experiment details

### 1. Persistence

Two phases on a single server:

1. **Writer** — a `BenchClient` seeds all memories from `datasets/starter.json`
   under a fresh `agent_id` (e.g. `persist_1713876543_abcd12`).
2. **Reader** — a *brand new* `BenchClient` instance queries each memory
   back by distinctive content and verifies the DB id is recoverable.

The two clients share only the server URL. Nothing is passed in-memory
between them.

Pass criterion: **≥ 95%** of seeded memories recoverable from the new
client.

Flags worth knowing:

```bash
npm run proof:persist -- --restart      # pause and ask you to
                                        # `docker compose restart neuromem`
                                        # between phases
npm run proof:persist -- --agent myrun  # pin the agent_id
npm run proof:persist -- --wait-ms 5000 # longer settle between phases
```

Report: `.bench/proof/persistence-<timestamp>.json`.

### 2. Cross-harness portability

This is the sharpest test of the "traverse to any harness" claim.

1. **Writer** — `BenchClient` over plain HTTP REST (`POST /tools/remember`).
   Stands in for any REST-based agent, script, or custom harness.
2. **Reader** — the *real* MCP SDK `Client` over Streamable HTTP,
   connecting to `/mcp` and calling the `recall` tool. This is the
   same protocol Claude Desktop, Claude Code, Cursor, and any other
   MCP-speaking harness use.

The reader verifies the MCP server advertises a `recall` tool, then
for each seeded memory it calls `recall(query=…, agent_id=…, limit=N)`
and checks the writer's DB id shows up in the returned list.

Pass criterion: **≥ 95%** of REST-written memories visible via MCP.

Report: `.bench/proof/cross-harness-<timestamp>.json`.

### 3. Task utility

The previous two proofs show NeuroMem *stores* and *retrieves*. This one
tests whether it *helps*: does an LLM that cannot answer a question
cold answer it correctly once the right memories are injected?

For every task in [`datasets/tasks.json`](../datasets/tasks.json):

1. **Cold** — ask the configured LLM with no context. Score the answer.
2. **Warm** — call `/tools/recall` with the task prompt, inject the
   top-K memories as a system prompt, ask the LLM again. Score.

Both answers go through a judge. The default judge is **keyword-based**
— it checks whether the task's `must_include` substrings appear in the
answer. No external LLM needed. You can swap in an LLM-as-judge with
`--judge anthropic|openai|ollama`.

Pass criterion: warm win-rate **≥ 70%** (configurable with `--threshold`).

#### Answerers and judges

| Provider | Env var needed | Default model |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-haiku-4-5-20251001` |
| `openai` | `OPENAI_API_KEY` | `gpt-4o-mini` |
| `ollama` | none (needs local Ollama) | `llama3.2` |
| `mock` | none | deterministic stub, only useful with the keyword judge |
| `keyword` (judge only) | none | n/a |

The answerer is picked automatically in this order: `anthropic` if the
key is set, else `openai` if the key is set, else `ollama`. Override
with `--answerer <name>`.

```bash
# use Anthropic for both answering and judging
ANTHROPIC_API_KEY=sk-... npm run proof:tasks -- --answerer anthropic --judge anthropic

# use Ollama locally, keyword judge (fully offline)
npm run proof:tasks -- --answerer ollama --model llama3.2 --judge keyword

# skip this experiment inside `npm run proof`
npm run proof -- --skip-tasks
```

Report: `.bench/proof/task-eval-<timestamp>.json`.

## Combined report

`npm run proof` runs all three experiments in sequence and writes a
single shareable Markdown summary:

```
.bench/proof/report.md
```

The report links to each JSON artifact, shows per-experiment verdicts,
and lists the cold-vs-warm table for every task. Safe to paste into a
PR description or pin in a project channel.

Useful flags:

```bash
npm run proof -- --include persistence,xharness   # subset
npm run proof -- --skip-tasks                     # shortcut
npm run proof -- --url http://remote-server:3000  # against a non-local host
npm run proof -- --answerer anthropic             # propagated to tasks
```

## What these proofs intentionally do *not* cover

- **Scale.** 40 memories, 12 tasks. This is a correctness harness, not
  a load test.
- **Adversarial agents.** No multi-agent isolation checks beyond the
  `agent_id` scoping already exercised by the benchmark.
- **Latency under load.** Covered by `npm run bench` (p50/p95 per query).
- **Temporal reasoning.** The `decay_factor` on episodic memories is not
  exercised here — the interval between writer and reader is ~1.5s by
  default.

If you extend this suite, keep each experiment single-purpose. The
value of the proof suite is that each script tests **one** claim, and
its pass/fail is legible from a single line of output.
