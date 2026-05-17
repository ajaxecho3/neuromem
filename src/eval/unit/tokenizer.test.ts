/**
 * Unit tests — tokenizer.ts
 * No Docker required. Run with: tsx src/eval/unit/tokenizer.test.ts
 */

import {
  countTokens,
  sumTokens,
  encodingForModel,
  getActiveEncoding,
  _resetActiveEncoding,
} from "../../utils/tokens.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  assert(actual === expected, `${label} (got: ${actual}, expected: ${expected})`);
}

// ── Test: encodingForModel ─────────────────────────────────────────
console.log("\n[tokenizer] encodingForModel");
assertEqual(encodingForModel("gpt-4o"), "o200k_base", "gpt-4o → o200k_base");
assertEqual(encodingForModel("gpt-4o-mini"), "o200k_base", "gpt-4o-mini → o200k_base");
assertEqual(encodingForModel("gpt-4.1-turbo"), "o200k_base", "gpt-4.1-turbo → o200k_base");
assertEqual(encodingForModel("o1"), "o200k_base", "o1 → o200k_base");
assertEqual(encodingForModel("o3-mini"), "o200k_base", "o3-mini → o200k_base");
assertEqual(encodingForModel("gpt-4"), "cl100k_base", "gpt-4 → cl100k_base");
assertEqual(encodingForModel("gpt-3.5-turbo"), "cl100k_base", "gpt-3.5-turbo → cl100k_base");
assertEqual(encodingForModel("claude-3-5-sonnet"), "cl100k_base", "claude → cl100k_base");
assertEqual(encodingForModel(undefined), "cl100k_base", "undefined → cl100k_base");
assertEqual(encodingForModel(null), "cl100k_base", "null → cl100k_base");

// ── Test: countTokens ──────────────────────────────────────────────
console.log("\n[tokenizer] countTokens");
assertEqual(countTokens(""), 0, "empty string = 0");
assertEqual(countTokens(null), 0, "null = 0");
assertEqual(countTokens(undefined), 0, "undefined = 0");

const sample = "Hello, world! This is a test sentence.";
const count = countTokens(sample);
assert(count > 0, `non-empty string produces tokens (got ${count})`);
assert(count < sample.length, "token count < char count for English");

// Deterministic: same string = same count
assertEqual(countTokens(sample), countTokens(sample), "deterministic across calls");

// Longer string = more tokens
const short = "Hi";
const long = "Hello, this is a much longer string with many more words in it.";
assert(countTokens(long) > countTokens(short), "longer string = more tokens");

// ── Test: sumTokens ────────────────────────────────────────────────
console.log("\n[tokenizer] sumTokens");
assertEqual(sumTokens([]), 0, "empty array = 0");
assertEqual(sumTokens([null, undefined, ""]), 0, "null/undefined/empty = 0");

const texts = ["Hello world", "This is a test", "Another sentence here"];
const total = sumTokens(texts);
const individual = texts.reduce((acc, t) => acc + countTokens(t), 0);
assertEqual(total, individual, "sumTokens equals sum of individual countTokens");

// ── Test: scoring math validation ─────────────────────────────────
console.log("\n[tokenizer] scoring math (build_context formula)");

function score(rank: number, importance: number, daysOld: number): number {
  const rank_relevance = Math.exp(-0.3 * rank);
  const importance_score = Math.pow(Math.max(0, Math.min(1, importance)), 0.7);
  const recency_decay = Math.exp(-0.05 * daysOld);
  return rank_relevance * importance_score * recency_decay;
}

const s0 = score(0, 1.0, 0);
const s1 = score(1, 1.0, 0);
const s5 = score(5, 1.0, 0);
assert(s0 > s1, `rank 0 scores higher than rank 1 (${s0.toFixed(3)} > ${s1.toFixed(3)})`);
assert(s1 > s5, `rank 1 scores higher than rank 5 (${s1.toFixed(3)} > ${s5.toFixed(3)})`);

const fresh = score(0, 0.8, 0);
const stale = score(0, 0.8, 60);
assert(fresh > stale, `fresh memory scores higher than 60-day-old (${fresh.toFixed(3)} > ${stale.toFixed(3)})`);

const highImp = score(0, 0.9, 0);
const lowImp = score(0, 0.3, 0);
assert(highImp > lowImp, `high importance scores higher than low (${highImp.toFixed(3)} > ${lowImp.toFixed(3)})`);

// ── Summary ────────────────────────────────────────────────────────
console.log(`\n[tokenizer] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
