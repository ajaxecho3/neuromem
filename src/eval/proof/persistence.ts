#!/usr/bin/env node
/**
 * Persistence proof.
 *
 * Claim under test: memories written to NeuroMem survive across clients
 * (and, with --restart, across server restarts). A fresh client process
 * can recall memories it never wrote itself.
 *
 * Method:
 *   1. Writer phase — a BenchClient seeds N memories under a fresh agent_id.
 *   2. (Optional) The user restarts the server between phases.
 *   3. Reader phase — a BRAND NEW BenchClient instance queries each memory
 *      by its distinctive content and verifies the DB id is recoverable.
 *   4. For every memory seeded, we recall by content keywords, then check
 *      that the seeded id appears in the returned list.
 *
 * Output:
 *   - Terminal table with per-memory pass/fail
 *   - JSON report at .bench/proof/persistence-<timestamp>.json
 *   - Exit code 0 if ≥ 95% of memories recovered, else 1
 *
 * Flags:
 *   --url <url>       Server URL (default: http://localhost:3000)
 *   --dataset <path>  Dataset (default: src/eval/datasets/starter.json)
 *   --agent <id>      Override agent_id (default: persist_<timestamp>_<rand>)
 *   --wait-ms <n>     Sleep between writer and reader phases (default: 1500)
 *   --restart         Pause and wait for user confirmation between phases
 *                     (use this when you will restart the server manually)
 *   --limit <n>       Recall limit per query (default: 10)
 *   --quiet           Suppress progress output
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { nanoid } from "nanoid";
import readline from "node:readline";
import { BenchClient } from "../client.js";
import type { BenchDataset, BenchMemory } from "../types.js";

interface Args {
  url: string;
  dataset: string;
  agent: string;
  waitMs: number;
  restart: boolean;
  limit: number;
  quiet: boolean;
  output: string;
}

interface MemoryVerdict {
  bench_id: string;
  seeded_db_id: string;
  recalled: boolean;
  rank: number | null;
  content_preview: string;
}

interface PersistenceReport {
  run_id: string;
  timestamp: string;
  server_url: string;
  agent_id: string;
  dataset_name: string;
  wait_ms: number;
  server_restarted: boolean;
  summary: {
    seeded: number;
    recovered: number;
    recovery_rate: number;
    verdict: "PASS" | "FAIL";
  };
  memories: MemoryVerdict[];
}

function parseArgs(argv: string[]): Args {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const defaultDataset = resolve(__dirname, "..", "datasets", "starter.json");
  const defaultOutput = join(
    process.cwd(),
    ".bench",
    "proof",
    `persistence-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );

  const args: Args = {
    url: process.env.NEUROMEM_URL ?? "http://localhost:3000",
    dataset: defaultDataset,
    agent: `persist_${Date.now()}_${nanoid(6)}`,
    waitMs: 1500,
    restart: false,
    limit: 10,
    quiet: false,
    output: defaultOutput,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--url": args.url = argv[++i]!; break;
      case "--dataset": args.dataset = resolve(process.cwd(), argv[++i]!); break;
      case "--agent": args.agent = argv[++i]!; break;
      case "--wait-ms": args.waitMs = Number(argv[++i]); break;
      case "--restart": args.restart = true; break;
      case "--limit": args.limit = Number(argv[++i]); break;
      case "--output": args.output = resolve(process.cwd(), argv[++i]!); break;
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
  return args;
}

function helpText(): string {
  return [
    "Usage: npm run proof:persist -- [flags]",
    "",
    "Flags:",
    "  --url <url>       Server URL (default: http://localhost:3000)",
    "  --dataset <path>  Dataset JSON (default: src/eval/datasets/starter.json)",
    "  --agent <id>      Override agent_id",
    "  --wait-ms <n>     Sleep between phases (default: 1500)",
    "  --restart         Pause and ask the user to restart the server manually",
    "  --limit <n>       Recall limit (default: 10)",
    "  --quiet           Suppress progress output",
  ].join("\n");
}

/**
 * Build a tight recall query from a memory's content. The goal of the
 * persistence proof is to verify *existence*, not to stress retrieval,
 * so we want the query to be as distinctive as possible. We take the
 * first 120 chars of content (or the full content if shorter). That is
 * usually long enough to make the target memory the top hit even when
 * multiple memories share keywords.
 */
function recallQueryFor(mem: BenchMemory): string {
  if (mem.title && mem.title.length > 8) return mem.title;
  const firstLine = mem.content.split("\n")[0] ?? "";
  return firstLine.slice(0, 120);
}

function prompt(q: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(q, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const log = args.quiet ? () => {} : console.log;

  const dataset = JSON.parse(readFileSync(args.dataset, "utf-8")) as BenchDataset;

  log(`[proof/persistence] server:  ${args.url}`);
  log(`[proof/persistence] dataset: ${dataset.meta.name} v${dataset.meta.version}`);
  log(`[proof/persistence] agent:   ${args.agent}`);
  log("");

  // ─── PHASE 1 — writer ─────────────────────────────────────────
  log("━━━ Phase 1 — writer ━━━");
  const writer = new BenchClient(args.url);
  await writer.health();

  const idMap = new Map<string, string>(); // bench_id → db_id

  for (const mem of dataset.memories) {
    const { id } = await writer.remember(mem, args.agent);
    idMap.set(mem.bench_id, id);
  }
  log(`[writer] seeded ${idMap.size} memories under ${args.agent}`);
  log("");

  // ─── INTERVAL — optional restart ──────────────────────────────
  let serverRestarted = false;
  if (args.restart) {
    log("━━━ Please restart the server now ━━━");
    log("  In another terminal:  docker compose restart neuromem");
    log("  Wait for the container to be healthy.");
    await prompt("  Press <Enter> when the server is back up... ");
    serverRestarted = true;
  } else {
    log(`[interval] waiting ${args.waitMs}ms for the system to quiesce...`);
    await new Promise((r) => setTimeout(r, args.waitMs));
  }
  log("");

  // ─── PHASE 2 — reader (brand new client) ──────────────────────
  log("━━━ Phase 2 — reader (fresh client) ━━━");
  const reader = new BenchClient(args.url);
  await reader.health();

  const verdicts: MemoryVerdict[] = [];
  let recovered = 0;

  for (const mem of dataset.memories) {
    const expectedDbId = idMap.get(mem.bench_id)!;
    const q = recallQueryFor(mem);

    const { memories } = await reader.recall(q, args.agent, {
      limit: args.limit,
    });

    const ranked = memories.map((m) => m.id);
    const rank = ranked.indexOf(expectedDbId);
    const hit = rank >= 0;

    if (hit) recovered++;

    verdicts.push({
      bench_id: mem.bench_id,
      seeded_db_id: expectedDbId,
      recalled: hit,
      rank: hit ? rank + 1 : null,
      content_preview: mem.content.slice(0, 60),
    });
  }

  const recoveryRate = recovered / dataset.memories.length;
  const verdict: "PASS" | "FAIL" = recoveryRate >= 0.95 ? "PASS" : "FAIL";

  // ─── OUTPUT ───────────────────────────────────────────────────
  const report: PersistenceReport = {
    run_id: `persist_${Date.now()}_${nanoid(6)}`,
    timestamp: new Date().toISOString(),
    server_url: args.url,
    agent_id: args.agent,
    dataset_name: `${dataset.meta.name} v${dataset.meta.version}`,
    wait_ms: args.waitMs,
    server_restarted: serverRestarted,
    summary: {
      seeded: dataset.memories.length,
      recovered,
      recovery_rate: Number(recoveryRate.toFixed(4)),
      verdict,
    },
    memories: verdicts,
  };

  const dir = dirname(args.output);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(args.output, JSON.stringify(report, null, 2));

  printReport(report);
  log(`\nreport written to ${args.output}`);

  process.exit(verdict === "PASS" ? 0 : 1);
}

function printReport(r: PersistenceReport): void {
  const BOLD = "\x1b[1m";
  const DIM = "\x1b[2m";
  const GREEN = "\x1b[32m";
  const RED = "\x1b[31m";
  const RESET = "\x1b[0m";

  console.log();
  console.log(`${BOLD}━━━ Persistence Proof ━━━${RESET}`);
  console.log(`${DIM}run_id:${RESET}    ${r.run_id}`);
  console.log(`${DIM}dataset:${RESET}   ${r.dataset_name}`);
  console.log(`${DIM}agent:${RESET}     ${r.agent_id}`);
  console.log(
    `${DIM}restart:${RESET}   ${r.server_restarted ? "yes (user confirmed)" : `no (waited ${r.wait_ms}ms)`}`,
  );
  console.log();

  const failed = r.memories.filter((m) => !m.recalled);
  const { summary } = r;
  const badge = summary.verdict === "PASS"
    ? `${GREEN}${BOLD}✓ PASS${RESET}`
    : `${RED}${BOLD}✗ FAIL${RESET}`;

  console.log(
    `${BOLD}Recovered${RESET}: ${summary.recovered} / ${summary.seeded} ` +
      `(${(summary.recovery_rate * 100).toFixed(1)}%)  ${badge}`,
  );
  console.log();

  if (failed.length > 0) {
    console.log(`${BOLD}Missing memories:${RESET}`);
    for (const m of failed) {
      console.log(
        `  ${RED}✗${RESET} ${m.bench_id}  ${DIM}${m.seeded_db_id}${RESET}  "${m.content_preview}..."`,
      );
    }
    console.log();
  }

  // Rank distribution for recovered ones
  const ranked = r.memories.filter((m) => m.recalled && m.rank !== null);
  if (ranked.length > 0) {
    const atRank1 = ranked.filter((m) => m.rank === 1).length;
    const atTop3 = ranked.filter((m) => m.rank! <= 3).length;
    const atTop5 = ranked.filter((m) => m.rank! <= 5).length;
    console.log(`${BOLD}Rank of recovered:${RESET}`);
    console.log(`  rank 1  : ${atRank1} / ${ranked.length}`);
    console.log(`  top 3   : ${atTop3} / ${ranked.length}`);
    console.log(`  top 5   : ${atTop5} / ${ranked.length}`);
    console.log();
  }
}

main().catch((err) => {
  console.error(
    `[proof/persistence] failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(2);
});
