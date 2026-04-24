#!/usr/bin/env node
/**
 * Combined proof runner.
 *
 * Runs all three proof experiments back-to-back against a single NeuroMem
 * instance, collects the JSON reports they emit, and produces a single
 * shareable Markdown summary at .bench/proof/report.md.
 *
 * Experiments:
 *   1. persistence    — does a memory written by one client survive the
 *                       jump to a brand-new client (and optionally across
 *                       a server restart)?
 *   2. cross-harness  — can a memory written over HTTP REST be recalled
 *                       over MCP Streamable HTTP (and vice-versa)?
 *   3. task utility   — does NeuroMem actually make the LLM better at
 *                       answering real questions (cold vs warm)?
 *
 * This runner shells out to each experiment via tsx so that exit codes,
 * console output, and the JSON artifacts on disk match exactly what you
 * would get running them individually.
 *
 * Flags of note:
 *   --include <list>  Comma-separated subset: persistence,xharness,tasks
 *                     (default: all three)
 *   --skip-tasks      Shorthand for --include persistence,xharness
 *                     (useful when no LLM is available)
 *   --url <url>       Propagated to every experiment
 *   --answerer <p>    Propagated to tasks
 *   --judge <p>       Propagated to tasks
 *   --out <path>      Output markdown path (default .bench/proof/report.md)
 *   --quiet           Propagated to every experiment
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Experiment = "persistence" | "xharness" | "tasks";

interface Args {
  url: string;
  include: Experiment[];
  answerer: string;
  judge: string;
  model?: string;
  judgeModel?: string;
  out: string;
  quiet: boolean;
  extra: string[]; // pass-through, appended to every experiment
}

const ALL: Experiment[] = ["persistence", "xharness", "tasks"];

function parseArgs(argv: string[]): Args {
  const args: Args = {
    url: process.env.NEUROMEM_URL ?? "http://localhost:3000",
    include: [...ALL],
    answerer:
      process.env.ANTHROPIC_API_KEY
        ? "anthropic"
        : process.env.OPENAI_API_KEY
          ? "openai"
          : "ollama",
    judge: "keyword",
    out: resolve(process.cwd(), ".bench", "proof", "report.md"),
    quiet: false,
    extra: [],
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--url": args.url = argv[++i]!; break;
      case "--include":
        args.include = (argv[++i] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s): s is Experiment => (ALL as string[]).includes(s));
        break;
      case "--skip-tasks": args.include = args.include.filter((e) => e !== "tasks"); break;
      case "--answerer": args.answerer = argv[++i]!; break;
      case "--judge": args.judge = argv[++i]!; break;
      case "--model": args.model = argv[++i]!; break;
      case "--judge-model": args.judgeModel = argv[++i]!; break;
      case "--out": args.out = resolve(process.cwd(), argv[++i]!); break;
      case "--quiet": args.quiet = true; break;
      case "-h":
      case "--help":
        console.log(helpText());
        process.exit(0);
      case "--":
        args.extra.push(...argv.slice(i + 1));
        i = argv.length;
        break;
      default:
        console.error(`Unknown flag: ${a}`);
        process.exit(2);
    }
  }
  return args;
}

function helpText(): string {
  return [
    "Usage: npm run proof -- [flags]",
    "",
    "Flags:",
    "  --url <url>           NeuroMem URL (default: http://localhost:3000)",
    "  --include <list>      Comma-separated: persistence,xharness,tasks",
    "  --skip-tasks          Shorthand to drop the task-utility experiment",
    "  --answerer <p>        Propagated to tasks (ollama|openai|anthropic|mock)",
    "  --judge <p>           Propagated to tasks (keyword|ollama|openai|anthropic)",
    "  --model <name>        Propagated to tasks",
    "  --judge-model <name>  Propagated to tasks",
    "  --out <path>          Markdown output (default .bench/proof/report.md)",
    "  --quiet               Pass through to each experiment",
  ].join("\n");
}

// ─── Child runner ────────────────────────────────────────────────

interface Step {
  name: Experiment;
  script: string;
  exitCode: number;
  reportPath: string | null;
  durationMs: number;
}

function newestReport(dir: string, prefix: string): string | null {
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0] ? join(dir, candidates[0].f) : null;
}

function runChild(args: Args, exp: Experiment): Step {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const script = {
    persistence: join(__dirname, "persistence.ts"),
    xharness: join(__dirname, "cross-harness.ts"),
    tasks: join(__dirname, "task-eval.ts"),
  }[exp];

  const flags: string[] = ["--url", args.url];
  if (args.quiet) flags.push("--quiet");
  if (exp === "tasks") {
    flags.push("--answerer", args.answerer, "--judge", args.judge);
    if (args.model) flags.push("--model", args.model);
    if (args.judgeModel) flags.push("--judge-model", args.judgeModel);
  }
  flags.push(...args.extra);

  const started = Date.now();
  const proc = spawnSync("npx", ["tsx", script, ...flags], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
  });
  const durationMs = Date.now() - started;

  const reportDir = join(process.cwd(), ".bench", "proof");
  const prefix = { persistence: "persistence-", xharness: "cross-harness-", tasks: "task-eval-" }[exp];
  const reportPath = newestReport(reportDir, prefix);

  return {
    name: exp,
    script,
    exitCode: proc.status ?? 1,
    reportPath,
    durationMs,
  };
}

// ─── Markdown renderer ───────────────────────────────────────────

function humanMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function safeReadJSON(path: string | null): any | null {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function badge(verdict: "PASS" | "FAIL" | "—"): string {
  if (verdict === "PASS") return "**✅ PASS**";
  if (verdict === "FAIL") return "**❌ FAIL**";
  return "—";
}

function renderMarkdown(args: Args, steps: Step[]): string {
  const now = new Date().toISOString();

  const lines: string[] = [];
  lines.push(`# NeuroMem — Proof Report`);
  lines.push("");
  lines.push(`Generated: \`${now}\`  `);
  lines.push(`Server: \`${args.url}\`  `);
  lines.push(`Experiments: ${args.include.join(", ")}  `);
  lines.push("");
  lines.push(
    `This report answers three questions: does NeuroMem actually **persist** ` +
      `memories across clients, does it stay **portable** across transports, ` +
      `and does it make agents **better at real tasks**? Each experiment is ` +
      `a self-contained script under \`src/eval/proof/\` and its raw JSON ` +
      `artifact is linked below.`,
  );
  lines.push("");

  // ─── Top-level verdict table ────────────────────────────────
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`| Experiment | Result | Headline | Artifact |`);
  lines.push(`|---|---|---|---|`);
  for (const step of steps) {
    const j = safeReadJSON(step.reportPath);
    let verdict: "PASS" | "FAIL" | "—" = step.exitCode === 0 ? "PASS" : "FAIL";
    let headline = "—";

    if (step.name === "persistence" && j) {
      verdict = j.summary?.verdict ?? verdict;
      headline = `recovered ${j.summary?.recovered}/${j.summary?.seeded} (${((j.summary?.recovery_rate ?? 0) * 100).toFixed(1)}%)${j.server_restarted ? " across restart" : ""}`;
    } else if (step.name === "xharness" && j) {
      verdict = j.summary?.verdict ?? verdict;
      headline = `${j.writer?.transport} → ${j.reader?.transport}: ${j.summary?.recovered}/${j.summary?.seeded} (${((j.summary?.recovery_rate ?? 0) * 100).toFixed(1)}%)`;
    } else if (step.name === "tasks" && j) {
      verdict = j.summary?.verdict ?? verdict;
      headline = `warm win rate ${((j.summary?.warm_win_rate ?? 0) * 100).toFixed(1)}%, uplift ${((j.summary?.uplift_points ?? 0) * 100).toFixed(1)}pp`;
    }

    const rel = step.reportPath ? step.reportPath.replace(process.cwd() + "/", "") : "—";
    const art = step.reportPath ? `[${rel.split("/").pop()}](${rel})` : "—";
    lines.push(`| ${step.name} | ${badge(verdict)} | ${headline} | ${art} |`);
  }
  lines.push("");

  // ─── Per-experiment sections ────────────────────────────────
  for (const step of steps) {
    const j = safeReadJSON(step.reportPath);
    const title = {
      persistence: "Persistence",
      xharness: "Cross-harness portability",
      tasks: "Task utility",
    }[step.name];
    lines.push(`## ${title}`);
    lines.push("");
    lines.push(`Duration: ${humanMs(step.durationMs)} · exit code ${step.exitCode}`);
    lines.push("");

    if (!j) {
      lines.push(`_No report found at \`${step.reportPath ?? "(none)"}\`._`);
      lines.push("");
      continue;
    }

    if (step.name === "persistence") {
      const { summary } = j;
      lines.push(
        `A fresh client recalled **${summary.recovered}/${summary.seeded}** ` +
          `memories seeded by a different client (${(summary.recovery_rate * 100).toFixed(1)}%). ` +
          `Server restart: ${j.server_restarted ? "**yes**, confirmed by user" : `no (waited ${j.wait_ms}ms)`}.`,
      );
      lines.push("");
      const failed = (j.memories ?? []).filter((m: any) => !m.recalled);
      if (failed.length > 0) {
        lines.push(`Missing (${failed.length}):`);
        lines.push("");
        for (const m of failed.slice(0, 10)) {
          lines.push(`- \`${m.bench_id}\` — "${(m.content_preview ?? "").replace(/"/g, "'")}..."`);
        }
        if (failed.length > 10) lines.push(`- …and ${failed.length - 10} more.`);
        lines.push("");
      }
    }

    if (step.name === "xharness") {
      const { summary } = j;
      lines.push(
        `Writer spoke **${j.writer?.transport}** and reader spoke **${j.reader?.transport}** — ` +
          `they shared nothing but the server URL. The MCP reader found ` +
          `**${summary.recovered}/${summary.seeded}** of what the REST writer wrote ` +
          `(${(summary.recovery_rate * 100).toFixed(1)}%).`,
      );
      lines.push("");
      const failed = (j.memories ?? []).filter((m: any) => !m.recalled_via_mcp);
      if (failed.length > 0) {
        lines.push(`Not visible via MCP (${failed.length}):`);
        lines.push("");
        for (const m of failed.slice(0, 10)) {
          lines.push(`- \`${m.bench_id}\` — "${(m.content_preview ?? "").replace(/"/g, "'")}..."`);
        }
        if (failed.length > 10) lines.push(`- …and ${failed.length - 10} more.`);
        lines.push("");
      }
    }

    if (step.name === "tasks") {
      const { summary, providers } = j;
      lines.push(
        `Answerer: **${providers.answerer}** (\`${providers.model}\`) · Judge: **${providers.judge}**` +
          (providers.judge === "keyword" ? "" : ` (\`${providers.judge_model}\`)`),
      );
      lines.push("");
      lines.push(
        `With no context the LLM got **${summary.cold_correct}/${j.task_count}** tasks right. ` +
          `With NeuroMem context injected it got **${summary.warm_correct}/${j.task_count}** right ` +
          `— a **${((summary.uplift_points) * 100).toFixed(1)}pp uplift**. ` +
          `Warm strictly beat cold on ${summary.warm_wins}/${j.task_count} tasks ` +
          `(ties: ${summary.ties}, cold wins: ${summary.cold_wins}).`,
      );
      lines.push("");
      lines.push(`| Task | Cold | Warm | Δ | ctx |`);
      lines.push(`|---|---|---|---|---|`);
      for (const t of j.tasks ?? []) {
        const c = t.cold_score?.correct ? "✓" : "✗";
        const w = t.warm_score?.correct ? "✓" : "✗";
        const d = t.warm_better ? "↑" : t.warm_score?.score < t.cold_score?.score ? "↓" : "=";
        const ctx = t.retrieved_required ? "✓" : "✗";
        const prompt = (t.prompt ?? "").replace(/\|/g, "\\|").slice(0, 60);
        lines.push(`| \`${t.task_id}\` ${prompt} | ${c} (${((t.cold_score?.score ?? 0) * 100).toFixed(0)}%) | ${w} (${((t.warm_score?.score ?? 0) * 100).toFixed(0)}%) | ${d} | ${ctx} |`);
      }
      lines.push("");
    }
  }

  lines.push(`---`);
  lines.push(`_Generated by \`npm run proof\`. See [src/eval/proof/README.md](../../src/eval/proof/README.md) for how to interpret these results and re-run them._`);
  lines.push("");
  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv);
  const log = args.quiet ? () => {} : console.log;

  log(`[proof/all] running: ${args.include.join(", ")}`);
  log(`[proof/all] server:  ${args.url}`);
  log("");

  const steps: Step[] = [];
  for (const exp of args.include) {
    log(`\n══════════════════════════════════════════════════════`);
    log(`  ${exp}`);
    log(`══════════════════════════════════════════════════════\n`);
    steps.push(runChild(args, exp));
  }

  const md = renderMarkdown(args, steps);
  const outDir = dirname(args.out);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(args.out, md);

  console.log();
  console.log(`── Summary ──`);
  for (const s of steps) {
    const status = s.exitCode === 0 ? "✓" : "✗";
    console.log(
      `  ${status} ${s.name.padEnd(12)}  exit=${s.exitCode}  time=${humanMs(s.durationMs)}  ${s.reportPath ? s.reportPath.replace(process.cwd() + "/", "") : "(no artifact)"}`,
    );
  }
  console.log();
  console.log(`report: ${args.out}`);

  const anyFailed = steps.some((s) => s.exitCode !== 0);
  process.exit(anyFailed ? 1 : 0);
}

main();
