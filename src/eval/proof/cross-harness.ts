#!/usr/bin/env node
/**
 * Cross-harness portability proof.
 *
 * Claim under test: memories written by one harness (transport/protocol)
 * are recallable by a completely different harness against the same
 * NeuroMem instance. This is the "traverse to any harness" promise.
 *
 * Method:
 *   1. Writer: BenchClient (plain HTTP to /tools/remember). Simulates any
 *      REST-based agent, script, or custom harness.
 *   2. Reader: real MCP SDK Client over Streamable HTTP to /mcp. This is
 *      the *same protocol* Claude Desktop, Claude Code, Cursor, and any
 *      other MCP-speaking harness use. If this client can recall what the
 *      REST writer wrote, cross-harness portability is demonstrated.
 *
 *   The two clients share nothing but the server URL. No in-memory state,
 *   no file handoff, no shared library calls — just the server and its
 *   backing stores (Postgres / Chroma / Redis / Neo4j).
 *
 * Output:
 *   - Terminal table with per-memory pass/fail across the transport boundary
 *   - JSON report at .bench/proof/cross-harness-<timestamp>.json
 *   - Exit code 0 if ≥ 95% of memories recovered via MCP, else 1
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { nanoid } from "nanoid";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BenchClient } from "../client.js";
import type { BenchDataset, BenchMemory } from "../types.js";

interface Args {
  url: string;
  mcpUrl: string;
  dataset: string;
  agent: string;
  waitMs: number;
  limit: number;
  quiet: boolean;
  output: string;
}

interface CrossVerdict {
  bench_id: string;
  seeded_db_id: string;
  recalled_via_mcp: boolean;
  rank: number | null;
  content_preview: string;
}

interface CrossReport {
  run_id: string;
  timestamp: string;
  writer: { transport: "http-rest"; url: string };
  reader: { transport: "mcp-streamable-http"; url: string };
  agent_id: string;
  dataset_name: string;
  summary: {
    seeded: number;
    recovered: number;
    recovery_rate: number;
    verdict: "PASS" | "FAIL";
  };
  memories: CrossVerdict[];
}

function parseArgs(argv: string[]): Args {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const defaultDataset = resolve(__dirname, "..", "datasets", "starter.json");
  const defaultOutput = join(
    process.cwd(),
    ".bench",
    "proof",
    `cross-harness-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );

  const baseUrl = process.env.NEUROMEM_URL ?? "http://localhost:3000";

  const args: Args = {
    url: baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    dataset: defaultDataset,
    agent: `xhar_${Date.now()}_${nanoid(6)}`,
    waitMs: 1500,
    limit: 10,
    quiet: false,
    output: defaultOutput,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--url":
        args.url = argv[++i]!;
        args.mcpUrl = `${args.url}/mcp`;
        break;
      case "--mcp-url": args.mcpUrl = argv[++i]!; break;
      case "--dataset": args.dataset = resolve(process.cwd(), argv[++i]!); break;
      case "--agent": args.agent = argv[++i]!; break;
      case "--wait-ms": args.waitMs = Number(argv[++i]); break;
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
    "Usage: npm run proof:xharness -- [flags]",
    "",
    "Flags:",
    "  --url <url>       REST base URL (default: http://localhost:3000)",
    "  --mcp-url <url>   MCP endpoint (default: <url>/mcp)",
    "  --dataset <path>  Dataset JSON (default: src/eval/datasets/starter.json)",
    "  --agent <id>      Override agent_id",
    "  --wait-ms <n>     Sleep between writer and reader (default: 1500)",
    "  --limit <n>       Recall limit (default: 10)",
    "  --quiet           Suppress progress output",
  ].join("\n");
}

/**
 * Build a tight recall query from a memory's content. Same intent as
 * the persistence proof: we want to verify *existence* across the REST
 * → MCP boundary, not benchmark retrieval. The first 120 chars of
 * content are almost always distinctive enough to put the target
 * memory in the top-K.
 */
function recallQueryFor(mem: BenchMemory): string {
  if (mem.title && mem.title.length > 8) return mem.title;
  const firstLine = mem.content.split("\n")[0] ?? "";
  return firstLine.slice(0, 120);
}

/**
 * Pulls a list of memory ids out of an MCP `recall` tool call response.
 * The MCP server returns content blocks; we look for the JSON block.
 */
function extractIds(result: unknown): string[] {
  const r = result as any;
  if (!r) return [];

  // Streamable HTTP CallToolResult typically looks like:
  //   { content: [{ type: "text", text: "...JSON..." }], ... }
  const content = r.content ?? r.result?.content;
  if (!Array.isArray(content)) return [];

  for (const block of content) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    try {
      const parsed = JSON.parse(block.text);
      if (Array.isArray(parsed?.memories)) {
        return parsed.memories.map((m: any) => m.id).filter(Boolean);
      }
      if (Array.isArray(parsed)) {
        return parsed.map((m: any) => m.id).filter(Boolean);
      }
    } catch {
      /* skip non-JSON text blocks */
    }
  }
  return [];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const log = args.quiet ? () => {} : console.log;

  const dataset = JSON.parse(readFileSync(args.dataset, "utf-8")) as BenchDataset;

  log(`[proof/xharness] writer: HTTP REST  ${args.url}`);
  log(`[proof/xharness] reader: MCP HTTP   ${args.mcpUrl}`);
  log(`[proof/xharness] agent:             ${args.agent}`);
  log("");

  // ─── PHASE 1 — writer via HTTP REST ───────────────────────────
  log("━━━ Phase 1 — writer (HTTP REST) ━━━");
  const writer = new BenchClient(args.url);
  await writer.health();

  const idMap = new Map<string, string>();
  for (const mem of dataset.memories) {
    const { id } = await writer.remember(mem, args.agent);
    idMap.set(mem.bench_id, id);
  }
  log(`[writer] wrote ${idMap.size} memories via /tools/remember`);
  log("");

  if (args.waitMs > 0) {
    log(`[interval] waiting ${args.waitMs}ms for indexes to settle...`);
    await new Promise((r) => setTimeout(r, args.waitMs));
    log("");
  }

  // ─── PHASE 2 — reader via MCP client ──────────────────────────
  log("━━━ Phase 2 — reader (MCP Streamable HTTP) ━━━");
  const transport = new StreamableHTTPClientTransport(new URL(args.mcpUrl));
  const client = new Client(
    { name: "neuromem-xharness-reader", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  log(`[reader] connected to ${args.mcpUrl} via MCP Streamable HTTP`);

  // Verify the MCP server advertises a `recall` tool (catches shape mismatches
  // before we iterate over the whole dataset).
  const tools = await client.listTools();
  const recallTool = tools.tools.find((t) => t.name === "recall");
  if (!recallTool) {
    throw new Error(
      `MCP server at ${args.mcpUrl} does not expose a "recall" tool. Found: ${tools.tools
        .map((t) => t.name)
        .join(", ")}`,
    );
  }
  log(`[reader] server advertises ${tools.tools.length} tools (recall: ✓)`);
  log("");

  const verdicts: CrossVerdict[] = [];
  let recovered = 0;

  for (const mem of dataset.memories) {
    const expectedDbId = idMap.get(mem.bench_id)!;
    const q = recallQueryFor(mem);

    const result = await client.callTool({
      name: "recall",
      arguments: {
        query: q,
        agent_id: args.agent,
        limit: args.limit,
      },
    });

    const ids = extractIds(result);
    const rank = ids.indexOf(expectedDbId);
    const hit = rank >= 0;
    if (hit) recovered++;

    verdicts.push({
      bench_id: mem.bench_id,
      seeded_db_id: expectedDbId,
      recalled_via_mcp: hit,
      rank: hit ? rank + 1 : null,
      content_preview: mem.content.slice(0, 60),
    });
  }

  await client.close();

  const recoveryRate = recovered / dataset.memories.length;
  const verdict: "PASS" | "FAIL" = recoveryRate >= 0.95 ? "PASS" : "FAIL";

  const report: CrossReport = {
    run_id: `xhar_${Date.now()}_${nanoid(6)}`,
    timestamp: new Date().toISOString(),
    writer: { transport: "http-rest", url: args.url },
    reader: { transport: "mcp-streamable-http", url: args.mcpUrl },
    agent_id: args.agent,
    dataset_name: `${dataset.meta.name} v${dataset.meta.version}`,
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

function printReport(r: CrossReport): void {
  const BOLD = "\x1b[1m";
  const DIM = "\x1b[2m";
  const GREEN = "\x1b[32m";
  const RED = "\x1b[31m";
  const RESET = "\x1b[0m";

  console.log();
  console.log(`${BOLD}━━━ Cross-Harness Portability Proof ━━━${RESET}`);
  console.log(`${DIM}run_id:${RESET}   ${r.run_id}`);
  console.log(`${DIM}dataset:${RESET}  ${r.dataset_name}`);
  console.log(`${DIM}writer:${RESET}   ${r.writer.transport}   ${r.writer.url}`);
  console.log(`${DIM}reader:${RESET}   ${r.reader.transport}   ${r.reader.url}`);
  console.log(`${DIM}agent:${RESET}    ${r.agent_id}`);
  console.log();

  const { summary } = r;
  const badge = summary.verdict === "PASS"
    ? `${GREEN}${BOLD}✓ PASS${RESET}`
    : `${RED}${BOLD}✗ FAIL${RESET}`;

  console.log(
    `${BOLD}MCP reader recovered${RESET}: ${summary.recovered} / ${summary.seeded} ` +
      `(${(summary.recovery_rate * 100).toFixed(1)}%)  ${badge}`,
  );
  console.log();

  const failed = r.memories.filter((m) => !m.recalled_via_mcp);
  if (failed.length > 0) {
    console.log(`${BOLD}Not visible via MCP:${RESET}`);
    for (const m of failed) {
      console.log(
        `  ${RED}✗${RESET} ${m.bench_id}  ${DIM}${m.seeded_db_id}${RESET}  "${m.content_preview}..."`,
      );
    }
    console.log();
  }
}

main().catch((err) => {
  console.error(
    `[proof/xharness] failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(2);
});
