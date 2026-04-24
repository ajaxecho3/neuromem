#!/usr/bin/env node
/**
 * Benchmark CLI entry point.
 *
 * Usage:
 *   npm run bench
 *   npm run bench -- --dataset path/to/dataset.json
 *   npm run bench -- --baseline .bench/previous.json
 *
 * Flags:
 *   --dataset <path>    Path to a JSON dataset (default: src/eval/datasets/starter.json)
 *   --url <url>         NeuroMem server URL (default: http://localhost:3000)
 *   --agent <id>        Override the generated agent_id
 *   --limit <n>         Override the default recall limit (default: 10)
 *   --output <path>     Where to write the JSON report (default: .bench/<timestamp>.json)
 *   --baseline <path>   Compare against a previous report and flag regressions
 *   --quiet             Suppress progress output
 *
 * Exit codes:
 *   0  OK (or improvement vs baseline)
 *   1  Regression vs baseline (>2pp drop on recall@5, recall@10, or MRR)
 *   2  Run failed (could not reach server, etc.)
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { runBenchmark } from "./runner.js";
import {
  printReport,
  writeReport,
  loadReport,
  hasRegression,
} from "./reporter.js";

interface Args {
  dataset: string;
  url: string;
  agent?: string;
  limit: number;
  output: string;
  baseline?: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const defaultDataset = resolve(__dirname, "datasets", "starter.json");
  const defaultOutput = join(
    process.cwd(),
    ".bench",
    `${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );

  const args: Args = {
    dataset: defaultDataset,
    url: process.env.NEUROMEM_URL ?? "http://localhost:3000",
    limit: 10,
    output: defaultOutput,
    quiet: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dataset":
        args.dataset = resolve(process.cwd(), argv[++i]!);
        break;
      case "--url":
        args.url = argv[++i]!;
        break;
      case "--agent":
        args.agent = argv[++i]!;
        break;
      case "--limit":
        args.limit = Number(argv[++i]);
        break;
      case "--output":
        args.output = resolve(process.cwd(), argv[++i]!);
        break;
      case "--baseline":
        args.baseline = resolve(process.cwd(), argv[++i]!);
        break;
      case "--quiet":
        args.quiet = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        console.error(`Unknown flag: ${a}`);
        printHelp();
        process.exit(2);
    }
  }

  if (!existsSync(args.dataset)) {
    console.error(`Dataset not found: ${args.dataset}`);
    process.exit(2);
  }
  if (args.baseline && !existsSync(args.baseline)) {
    console.error(`Baseline not found: ${args.baseline}`);
    process.exit(2);
  }
  return args;
}

function printHelp(): void {
  console.log(
    [
      "Usage: npm run bench -- [flags]",
      "",
      "Flags:",
      "  --dataset <path>    JSON dataset (default: src/eval/datasets/starter.json)",
      "  --url <url>         NeuroMem server URL (default: http://localhost:3000)",
      "  --agent <id>        Override generated agent_id",
      "  --limit <n>         Recall limit (default: 10)",
      "  --output <path>     JSON report path (default: .bench/<timestamp>.json)",
      "  --baseline <path>   Compare vs previous report; exit 1 on regression",
      "  --quiet             Suppress progress output",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  let report;
  try {
    report = await runBenchmark({
      dataset_path: args.dataset,
      server_url: args.url,
      agent_id: args.agent,
      recall_limit: args.limit,
      output_path: args.output,
      baseline_path: args.baseline,
      quiet: args.quiet,
    });
  } catch (err) {
    console.error(
      `[bench] failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }

  const baseline = args.baseline ? loadReport(args.baseline) : undefined;
  printReport(report, baseline);
  writeReport(report, args.output);

  if (baseline && hasRegression(report, baseline)) {
    process.exit(1);
  }
  process.exit(0);
}

main();
