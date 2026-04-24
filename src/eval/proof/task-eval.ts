#!/usr/bin/env node
/**
 * Task utility proof.
 *
 * Claim under test: NeuroMem actually makes agents *better at real tasks*,
 * not just at recall. A question that the LLM cannot answer cold, on its
 * own, can be answered correctly once NeuroMem retrieves the right
 * memories and injects them as context.
 *
 * Method:
 *   1. Seed the knowledge dataset (starter.json memories) under a fresh
 *      agent_id. These are the "things the agent should know".
 *   2. For each task in tasks.json:
 *        a. COLD — ask the LLM with no context. Score the answer.
 *        b. WARM — call NeuroMem recall with the task prompt, inject top-K
 *           memories as context, ask the LLM again. Score the answer.
 *   3. Aggregate win rate of WARM over COLD.
 *
 * Scoring:
 *   - Default "keyword" judge (no external LLM required): each task lists
 *     `must_include` strings. Score = fraction of those strings present in
 *     the answer, case-insensitive. A task is "correct" if score ≥ 0.7.
 *   - Optional LLM-as-judge providers: ollama | openai | anthropic.
 *     The judge sees the task, the ideal answer, and the candidate answer,
 *     then returns {score 0-5, correct: bool}.
 *
 * Answerer providers (the LLM that actually answers the task):
 *   - ollama  (default, no API key, expects http://localhost:11434)
 *   - openai  (uses OPENAI_API_KEY)
 *   - anthropic (uses ANTHROPIC_API_KEY)
 *   - mock    (deterministic no-network stub — only useful if judge=keyword)
 *
 * The answerer is orthogonal to the judge: you can mix any pair.
 *
 * Output:
 *   - Terminal table of cold vs warm per task
 *   - JSON report at .bench/proof/task-eval-<timestamp>.json
 *   - Exit 0 if warm win rate ≥ threshold (default 0.7), else 1
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { nanoid } from "nanoid";
import { BenchClient } from "../client.js";
import type { BenchDataset } from "../types.js";
import type { Memory } from "../../types/index.js";

// ─── Types ───────────────────────────────────────────────────────

interface Task {
  task_id: string;
  prompt: string;
  requires_memories: string[];
  must_include: string[];
  ideal: string;
}

interface TaskDataset {
  meta: { name: string; version: string; description: string };
  tasks: Task[];
}

type AnswererName = "ollama" | "openai" | "anthropic" | "mock";
type JudgeName = "keyword" | "ollama" | "openai" | "anthropic";

interface Args {
  url: string;
  dataset: string;
  tasksPath: string;
  agent: string;
  recallLimit: number;
  threshold: number;
  answerer: AnswererName;
  judge: JudgeName;
  model: string;
  judgeModel: string;
  quiet: boolean;
  output: string;
  skipSeed: boolean;
}

interface AnswerScore {
  score: number; // 0..1
  correct: boolean;
  rationale?: string;
}

interface TaskVerdict {
  task_id: string;
  prompt: string;
  requires_memories: string[];
  cold_answer: string;
  cold_score: AnswerScore;
  warm_answer: string;
  warm_score: AnswerScore;
  context_ids: string[];
  warm_better: boolean;
  retrieved_required: boolean;
}

interface TaskReport {
  run_id: string;
  timestamp: string;
  server_url: string;
  agent_id: string;
  dataset_name: string;
  task_count: number;
  providers: { answerer: AnswererName; judge: JudgeName; model: string; judge_model: string };
  summary: {
    cold_correct: number;
    warm_correct: number;
    warm_wins: number;
    ties: number;
    cold_wins: number;
    warm_win_rate: number;
    uplift_points: number;
    verdict: "PASS" | "FAIL";
  };
  tasks: TaskVerdict[];
}

// ─── CLI ─────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const defaultDataset = resolve(__dirname, "..", "datasets", "starter.json");
  const defaultTasks = resolve(__dirname, "..", "datasets", "tasks.json");
  const defaultOutput = join(
    process.cwd(),
    ".bench",
    "proof",
    `task-eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );

  const args: Args = {
    url: process.env.NEUROMEM_URL ?? "http://localhost:3000",
    dataset: defaultDataset,
    tasksPath: defaultTasks,
    agent: `taskeval_${Date.now()}_${nanoid(6)}`,
    recallLimit: 5,
    threshold: 0.7,
    answerer: (process.env.ANTHROPIC_API_KEY
      ? "anthropic"
      : process.env.OPENAI_API_KEY
        ? "openai"
        : "ollama") as AnswererName,
    judge: "keyword",
    model: process.env.NEUROMEM_LLM_MODEL ?? "",
    judgeModel: process.env.NEUROMEM_JUDGE_MODEL ?? "",
    quiet: false,
    output: defaultOutput,
    skipSeed: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--url": args.url = argv[++i]!; break;
      case "--dataset": args.dataset = resolve(process.cwd(), argv[++i]!); break;
      case "--tasks": args.tasksPath = resolve(process.cwd(), argv[++i]!); break;
      case "--agent": args.agent = argv[++i]!; break;
      case "--recall-limit": args.recallLimit = Number(argv[++i]); break;
      case "--threshold": args.threshold = Number(argv[++i]); break;
      case "--answerer": args.answerer = argv[++i] as AnswererName; break;
      case "--judge": args.judge = argv[++i] as JudgeName; break;
      case "--model": args.model = argv[++i]!; break;
      case "--judge-model": args.judgeModel = argv[++i]!; break;
      case "--output": args.output = resolve(process.cwd(), argv[++i]!); break;
      case "--skip-seed": args.skipSeed = true; break;
      case "--quiet": args.quiet = true; break;
      case "-h":
      case "--help":
        console.log(helpText());
        process.exit(0);
      default:
        console.error(`Unknown flag: ${a}`);
        process.exit(2);
    }
  }

  // Set reasonable default models based on provider
  if (!args.model) {
    args.model = defaultModel(args.answerer);
  }
  if (!args.judgeModel) {
    args.judgeModel = args.judge === "keyword" ? "n/a" : defaultModel(args.judge as AnswererName);
  }
  return args;
}

function defaultModel(provider: AnswererName): string {
  switch (provider) {
    case "ollama": return process.env.OLLAMA_MODEL ?? "llama3.2";
    case "openai": return process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    case "anthropic": return process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
    case "mock": return "mock";
  }
}

function helpText(): string {
  return [
    "Usage: npm run proof:tasks -- [flags]",
    "",
    "Flags:",
    "  --url <url>           NeuroMem URL (default: http://localhost:3000)",
    "  --dataset <path>      Seed memories dataset (default: starter.json)",
    "  --tasks <path>        Task dataset (default: tasks.json)",
    "  --agent <id>          Override agent_id",
    "  --recall-limit <n>    Context memories per task (default: 5)",
    "  --threshold <0..1>    Pass threshold on warm win rate (default: 0.7)",
    "  --answerer <p>        ollama | openai | anthropic | mock",
    "  --judge <p>           keyword (default) | ollama | openai | anthropic",
    "  --model <name>        Model for the answerer",
    "  --judge-model <name>  Model for the judge (LLM-as-judge only)",
    "  --skip-seed           Don't seed memories (assume already present)",
    "  --quiet               Suppress progress output",
    "",
    "Env:",
    "  ANTHROPIC_API_KEY, OPENAI_API_KEY   Picked up automatically",
    "  OLLAMA_URL (default http://localhost:11434)",
    "  OLLAMA_MODEL / OPENAI_MODEL / ANTHROPIC_MODEL",
  ].join("\n");
}

// ─── LLM callers ─────────────────────────────────────────────────

async function callOllama(prompt: string, model: string, system?: string): Promise<string> {
  const url = process.env.OLLAMA_URL ?? "http://localhost:11434";
  const res = await fetch(`${url}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: system ? `${system}\n\n${prompt}` : prompt,
      stream: false,
      options: { temperature: 0.2 },
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  const json = (await res.json()) as { response: string };
  return (json.response ?? "").trim();
}

async function callOpenAI(prompt: string, model: string, system?: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

async function callAnthropic(prompt: string, model: string, system?: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      temperature: 0.2,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { content: Array<{ type: string; text: string }> };
  return (json.content?.find((c) => c.type === "text")?.text ?? "").trim();
}

/**
 * Deterministic answerer used only when the user explicitly picks `mock`.
 * It returns a stock "I don't know" string when given no context; and when
 * context is provided, it naively echoes the first line of the first
 * context memory. This lets users dry-run the harness without any LLM.
 */
function mockAnswer(prompt: string, context?: string): string {
  if (!context || context.trim().length === 0) {
    return "I don't have enough information to answer that.";
  }
  const firstMem = context.split(/\n\s*\n/).find((b) => b.trim().length > 0) ?? "";
  return firstMem.split("\n").slice(0, 3).join(" ").trim();
}

async function askLLM(
  provider: AnswererName,
  model: string,
  prompt: string,
  system?: string,
): Promise<string> {
  switch (provider) {
    case "ollama": return callOllama(prompt, model, system);
    case "openai": return callOpenAI(prompt, model, system);
    case "anthropic": return callAnthropic(prompt, model, system);
    case "mock":
      // The `system` field carries context in our wiring below; the mock
      // answerer uses it as the "knowledge" to echo back.
      return mockAnswer(prompt, system);
  }
}

// ─── Judges ──────────────────────────────────────────────────────

function judgeByKeywords(task: Task, answer: string): AnswerScore {
  if (!answer || answer.trim().length === 0) {
    return { score: 0, correct: false, rationale: "empty answer" };
  }
  const lower = answer.toLowerCase();
  const hits = task.must_include.filter((s) => lower.includes(s.toLowerCase()));
  const score = task.must_include.length === 0 ? 1 : hits.length / task.must_include.length;
  return {
    score,
    correct: score >= 0.7,
    rationale: `matched ${hits.length}/${task.must_include.length}: [${hits.join(", ")}]`,
  };
}

async function judgeByLLM(
  provider: AnswererName,
  model: string,
  task: Task,
  answer: string,
): Promise<AnswerScore> {
  const system =
    "You are a strict grader. Score the candidate answer against the reference on a 0-5 scale. " +
    'Reply with ONLY valid JSON: {"score": <0-5>, "correct": <true|false>, "rationale": "<=20 words"}.';
  const user = [
    `QUESTION: ${task.prompt}`,
    `REFERENCE ANSWER: ${task.ideal}`,
    `MUST INCLUDE FACTS: ${task.must_include.join(" | ")}`,
    `CANDIDATE ANSWER: ${answer || "(empty)"}`,
    "",
    "An answer is `correct` if it states the required facts. Hallucinations or vague hedging are NOT correct.",
    "Return JSON only, no prose.",
  ].join("\n");

  const raw = await askLLM(provider, model, user, system);
  // Pull the first {...} block in case the model wrapped it in prose.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return { score: 0, correct: false, rationale: `judge returned non-JSON: ${raw.slice(0, 80)}` };
  }
  try {
    const parsed = JSON.parse(match[0]) as { score: number; correct: boolean; rationale?: string };
    const score01 = Math.max(0, Math.min(1, (parsed.score ?? 0) / 5));
    return {
      score: score01,
      correct: Boolean(parsed.correct),
      rationale: parsed.rationale,
    };
  } catch (e) {
    return { score: 0, correct: false, rationale: `judge JSON parse failed: ${(e as Error).message}` };
  }
}

async function runJudge(
  judge: JudgeName,
  judgeModel: string,
  task: Task,
  answer: string,
): Promise<AnswerScore> {
  if (judge === "keyword") return judgeByKeywords(task, answer);
  return judgeByLLM(judge as AnswererName, judgeModel, task, answer);
}

// ─── Context formatting ──────────────────────────────────────────

function formatContext(memories: Memory[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((m, i) => {
    const tags = m.tags && m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
    const title = m.title ? `${m.title}: ` : "";
    return `(${i + 1}) ${title}${m.content}${tags}`;
  });
  return [
    "You have access to the following memories from prior sessions:",
    ...lines,
    "",
    "Use ONLY these memories to answer. If they do not contain the answer, say so.",
  ].join("\n");
}

const ANSWERER_SYSTEM =
  "You answer questions about an engineering team's codebase and operations. " +
  "Be concise and specific. If you don't know, say so — do not invent facts.";

// ─── Pre-flight ──────────────────────────────────────────────────

/**
 * Sanity-check the answerer/judge providers before we run 12 tasks × 2
 * calls each only to find out the model isn't there. We do the cheapest
 * possible reachability probe and surface a remediation hint when it
 * fails, instead of burying errors in per-task output.
 */
async function preflight(args: Args): Promise<void> {
  const needed: { kind: "answerer" | "judge"; provider: AnswererName; model: string }[] = [
    { kind: "answerer", provider: args.answerer, model: args.model },
  ];
  if (args.judge !== "keyword") {
    needed.push({ kind: "judge", provider: args.judge as AnswererName, model: args.judgeModel });
  }

  for (const n of needed) {
    try {
      // tiny probe — "ok" is all we need back
      await askLLM(n.provider, n.model, "Reply with the single word: ok", "You are terse.");
    } catch (e) {
      const msg = (e as Error).message;
      const hint = hintFor(n.provider, n.model, msg);
      throw new Error(
        `[preflight] ${n.kind} (${n.provider}/${n.model}) is not reachable.\n  ${msg}\n  ${hint}`,
      );
    }
  }
}

function hintFor(provider: AnswererName, model: string, msg: string): string {
  if (provider === "ollama") {
    if (/model .* not found/i.test(msg) || /404/.test(msg)) {
      return `Pull the model first: \`ollama pull ${model}\`. Or try \`--answerer mock\` for a no-LLM dry run.`;
    }
    return `Is Ollama running? \`curl ${process.env.OLLAMA_URL ?? "http://localhost:11434"}/api/tags\`. Or try \`--answerer mock\`.`;
  }
  if (provider === "openai") return "Check OPENAI_API_KEY and the selected --model.";
  if (provider === "anthropic") return "Check ANTHROPIC_API_KEY and the selected --model.";
  return `Try \`--answerer mock\` to run without any LLM.`;
}

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const log = args.quiet ? () => {} : console.log;

  const seed = JSON.parse(readFileSync(args.dataset, "utf-8")) as BenchDataset;
  const tasks = (JSON.parse(readFileSync(args.tasksPath, "utf-8")) as TaskDataset).tasks;

  log(`[proof/tasks] server:    ${args.url}`);
  log(`[proof/tasks] agent:     ${args.agent}`);
  log(`[proof/tasks] answerer:  ${args.answerer} (${args.model})`);
  log(`[proof/tasks] judge:     ${args.judge}${args.judge === "keyword" ? "" : ` (${args.judgeModel})`}`);
  log(`[proof/tasks] tasks:     ${tasks.length}`);
  log("");

  const client = new BenchClient(args.url);
  await client.health();

  // Fail fast if the LLM isn't reachable — better to hit the hint early
  // than to watch 24 identical 404s scroll by.
  if (args.answerer !== "mock") {
    log("[preflight] checking LLM reachability...");
    await preflight(args);
    log("[preflight] ok");
    log("");
  }

  // ─── Seed memories (unless skipped) ────────────────────────────
  if (!args.skipSeed) {
    log("━━━ Seeding memories ━━━");
    let seeded = 0;
    for (const mem of seed.memories) {
      await client.remember(mem, args.agent);
      seeded++;
    }
    log(`[seed] wrote ${seeded} memories under ${args.agent}`);
    log("");
  }

  // ─── Run tasks ─────────────────────────────────────────────────
  log("━━━ Running tasks (cold vs warm) ━━━");
  const verdicts: TaskVerdict[] = [];
  let coldCorrect = 0;
  let warmCorrect = 0;
  let warmWins = 0;
  let ties = 0;
  let coldWins = 0;

  for (const task of tasks) {
    log(`  ▸ ${task.task_id}  ${task.prompt.slice(0, 60)}...`);

    // COLD — no context
    let coldAnswer = "";
    try {
      coldAnswer = await askLLM(args.answerer, args.model, task.prompt, ANSWERER_SYSTEM);
    } catch (e) {
      coldAnswer = `[answerer error: ${(e as Error).message}]`;
    }
    const coldScore = await runJudge(args.judge, args.judgeModel, task, coldAnswer);

    // WARM — recall + inject
    const { memories } = await client.recall(task.prompt, args.agent, { limit: args.recallLimit });
    const retrievedReq = task.requires_memories.every((req) => {
      // bench_ids don't round-trip to DB ids, so we match by content substring
      const needle = seed.memories.find((m) => m.bench_id === req)?.content.slice(0, 40) ?? "";
      return memories.some((m) => m.content.includes(needle));
    });
    const contextBlock = formatContext(memories);
    const warmSystem =
      args.answerer === "mock"
        ? contextBlock // mock uses system field as context
        : `${ANSWERER_SYSTEM}\n\n${contextBlock}`;

    let warmAnswer = "";
    try {
      warmAnswer = await askLLM(args.answerer, args.model, task.prompt, warmSystem);
    } catch (e) {
      warmAnswer = `[answerer error: ${(e as Error).message}]`;
    }
    const warmScore = await runJudge(args.judge, args.judgeModel, task, warmAnswer);

    if (coldScore.correct) coldCorrect++;
    if (warmScore.correct) warmCorrect++;
    const warmBetter = warmScore.score > coldScore.score;
    if (warmBetter) warmWins++;
    else if (warmScore.score === coldScore.score) ties++;
    else coldWins++;

    verdicts.push({
      task_id: task.task_id,
      prompt: task.prompt,
      requires_memories: task.requires_memories,
      cold_answer: coldAnswer,
      cold_score: coldScore,
      warm_answer: warmAnswer,
      warm_score: warmScore,
      context_ids: memories.map((m) => m.id),
      warm_better: warmBetter,
      retrieved_required: retrievedReq,
    });
  }

  const total = tasks.length;
  const warmWinRate = total === 0 ? 0 : warmWins / total;
  const uplift = (warmCorrect - coldCorrect) / Math.max(total, 1);
  const verdict: "PASS" | "FAIL" = warmWinRate >= args.threshold ? "PASS" : "FAIL";

  const report: TaskReport = {
    run_id: `taskeval_${Date.now()}_${nanoid(6)}`,
    timestamp: new Date().toISOString(),
    server_url: args.url,
    agent_id: args.agent,
    dataset_name: `${seed.meta.name} v${seed.meta.version}`,
    task_count: total,
    providers: {
      answerer: args.answerer,
      judge: args.judge,
      model: args.model,
      judge_model: args.judgeModel,
    },
    summary: {
      cold_correct: coldCorrect,
      warm_correct: warmCorrect,
      warm_wins: warmWins,
      ties,
      cold_wins: coldWins,
      warm_win_rate: Number(warmWinRate.toFixed(4)),
      uplift_points: Number(uplift.toFixed(4)),
      verdict,
    },
    tasks: verdicts,
  };

  const dir = dirname(args.output);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(args.output, JSON.stringify(report, null, 2));

  printReport(report);
  log(`\nreport written to ${args.output}`);

  process.exit(verdict === "PASS" ? 0 : 1);
}

function printReport(r: TaskReport): void {
  const BOLD = "\x1b[1m";
  const DIM = "\x1b[2m";
  const GREEN = "\x1b[32m";
  const RED = "\x1b[31m";
  const YELLOW = "\x1b[33m";
  const RESET = "\x1b[0m";

  console.log();
  console.log(`${BOLD}━━━ Task Utility Proof ━━━${RESET}`);
  console.log(`${DIM}run_id:${RESET}    ${r.run_id}`);
  console.log(`${DIM}agent:${RESET}     ${r.agent_id}`);
  console.log(`${DIM}answerer:${RESET}  ${r.providers.answerer} (${r.providers.model})`);
  console.log(`${DIM}judge:${RESET}     ${r.providers.judge} (${r.providers.judge_model})`);
  console.log();

  const { summary } = r;
  const badge = summary.verdict === "PASS"
    ? `${GREEN}${BOLD}✓ PASS${RESET}`
    : `${RED}${BOLD}✗ FAIL${RESET}`;

  console.log(
    `${BOLD}Correct (cold → warm):${RESET} ${summary.cold_correct} → ${summary.warm_correct}   ` +
      `${DIM}(uplift ${(summary.uplift_points * 100).toFixed(1)}pp)${RESET}`,
  );
  console.log(
    `${BOLD}Warm wins:${RESET} ${summary.warm_wins} / ${r.task_count}  ` +
      `${DIM}(ties ${summary.ties}, cold wins ${summary.cold_wins})${RESET}   ` +
      `rate ${(summary.warm_win_rate * 100).toFixed(1)}%  ${badge}`,
  );
  console.log();

  console.log(`${BOLD}Per-task:${RESET}`);
  for (const t of r.tasks) {
    const cStr = t.cold_score.correct ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const wStr = t.warm_score.correct ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const arrow = t.warm_better
      ? `${GREEN}↑${RESET}`
      : t.warm_score.score < t.cold_score.score
        ? `${RED}↓${RESET}`
        : `${YELLOW}=${RESET}`;
    const retrieved = t.retrieved_required ? `${DIM}ctx✓${RESET}` : `${YELLOW}ctx✗${RESET}`;
    console.log(
      `  ${t.task_id}  cold ${cStr} (${(t.cold_score.score * 100).toFixed(0)}%)  ` +
        `warm ${wStr} (${(t.warm_score.score * 100).toFixed(0)}%)  ${arrow}  ${retrieved}  ` +
        `${DIM}${t.prompt.slice(0, 50)}${RESET}`,
    );
  }
  console.log();
}

main().catch((err) => {
  console.error(
    `[proof/tasks] failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(2);
});
