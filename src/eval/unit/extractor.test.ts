/**
 * Unit tests — Extractor.ts
 * No Docker required. Mocks InnerThought and MemoryManager.
 * Run with: tsx src/eval/unit/extractor.test.ts
 */

import { extractAndStore } from "../../cognition/Extractor.js";
import type { MemoryManager } from "../../stores/MemoryManager.js";
import type { InnerThought } from "../../cognition/InnerThought.js";
import type { WriteMemoryInput } from "../../types/index.js";

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

// ── Mock helpers ───────────────────────────────────────────────────

function makeMockMgr(onBatch: (inputs: WriteMemoryInput[]) => void = () => {}) {
  return {
    rememberBatch: async (inputs: WriteMemoryInput[]) => {
      onBatch(inputs);
      return { stored: inputs.length, duplicates: 0, results: [] };
    },
    innerThought: undefined,
  } as unknown as MemoryManager;
}

function makeMockInnerThought(response: string | null): InnerThought {
  return {
    reason: async (_prompt: string) => response,
  } as InnerThought;
}

// ── Test 1: LLM extraction stores valid items ──────────────────────
console.log("\n[extractor] LLM extraction");

{
  const stored: WriteMemoryInput[] = [];
  const mgr = makeMockMgr((inputs) => stored.push(...inputs));

  const llmResponse = JSON.stringify([
    { content: "The user prefers TypeScript over JavaScript for all projects.", type: "semantic", importance: 0.85, tags: ["typescript", "preferences"] },
    { content: "User decided to use PostgreSQL for the main database.", type: "episodic", importance: 0.75, tags: ["database"] },
    { content: "Short.", type: "semantic", importance: 0.8, tags: [] }, // too short — should be filtered
    { content: "Is this relevant?", type: "semantic", importance: 0.9, tags: [] }, // ends in ? — filtered
    { content: "Low importance fact about nothing in particular.", type: "semantic", importance: 0.1, tags: [] }, // too low importance
  ]);

  const innerThought = makeMockInnerThought(llmResponse);
  const result = await extractAndStore(
    "test-agent",
    "What tech stack should I use?",
    "Use TypeScript and PostgreSQL.",
    mgr,
    innerThought,
  );

  assert(result.extracted === 2, `stored 2 items (got ${result.extracted})`);
  assert(result.skipped >= 3, `skipped 3 items (got ${result.skipped})`);
  assert(!result.fallback, "did not use fallback");
  assert(stored.length === 2, `mgr.rememberBatch called with 2 items`);
  assert(stored[0].content.includes("TypeScript"), "first item is TypeScript pref");
}

// ── Test 2: InnerThought timeout triggers regex fallback ───────────
console.log("\n[extractor] Regex fallback on timeout");

{
  const stored: WriteMemoryInput[] = [];
  const mgr = makeMockMgr((inputs) => stored.push(...inputs));

  // InnerThought that never resolves (simulates timeout)
  const slowInnerThought: InnerThought = {
    reason: () => new Promise(() => {}), // never resolves
  } as unknown as InnerThought;

  const result = await extractAndStore(
    "test-agent",
    "Remember that I always use tabs for indentation.",
    "Got it — I'll remember you always use tabs.",
    mgr,
    slowInnerThought,
  );

  assert(result.fallback, "fallback was used");
  assert(result.extracted >= 0, "extraction did not throw");

  // Check fallback items are tagged correctly
  if (stored.length > 0) {
    assert(
      stored.some((s) => s.tags?.includes("auto-extracted-fallback")),
      "fallback items tagged with auto-extracted-fallback",
    );
  }
}

// ── Test 3: No InnerThought — fallback only ────────────────────────
console.log("\n[extractor] No InnerThought (NoopProvider)");

{
  const stored: WriteMemoryInput[] = [];
  const mgr = makeMockMgr((inputs) => stored.push(...inputs));

  const result = await extractAndStore(
    "test-agent",
    "I decided to migrate to the new API next week.",
    "That sounds like a solid plan. I'll help you with the migration.",
    mgr,
    undefined, // no InnerThought
  );

  assert(result.extracted >= 0, "no throw without InnerThought");
  assert(typeof result.fallback === "boolean", "fallback flag is boolean");
}

// ── Test 4: Malformed LLM JSON falls back to regex ─────────────────
console.log("\n[extractor] Malformed LLM JSON → regex fallback");

{
  const mgr = makeMockMgr();
  const innerThought = makeMockInnerThought("not valid json {{ broken");

  const result = await extractAndStore(
    "test-agent",
    "I always prefer dark mode.",
    "Noted — dark mode it is.",
    mgr,
    innerThought,
  );

  // Should not throw, should attempt fallback
  assert(typeof result.extracted === "number", "extracted is a number");
  assert(typeof result.fallback === "boolean", "fallback is a boolean");
}

// ── Test 5: Empty exchange → 0 stored ─────────────────────────────
console.log("\n[extractor] Empty exchange");

{
  const mgr = makeMockMgr();
  const innerThought = makeMockInnerThought("[]"); // LLM says nothing to remember

  const result = await extractAndStore(
    "test-agent",
    "Hi",
    "Hello!",
    mgr,
    innerThought,
  );

  assert(result.extracted === 0, "nothing stored for trivial exchange");
}

// ── Test 6: Never throws on bad input ─────────────────────────────
console.log("\n[extractor] Error safety");

{
  // MemoryManager that always throws
  const crashingMgr = {
    rememberBatch: async () => { throw new Error("DB down"); },
    innerThought: undefined,
  } as unknown as MemoryManager;

  const innerThought = makeMockInnerThought(
    JSON.stringify([{ content: "A valid fact to store here.", type: "semantic", importance: 0.8, tags: [] }])
  );

  let threw = false;
  try {
    await extractAndStore("test-agent", "user msg", "assistant msg", crashingMgr, innerThought);
  } catch {
    threw = true;
  }

  assert(!threw, "extractAndStore never throws even when mgr crashes");
}

// ── Summary ────────────────────────────────────────────────────────
console.log(`\n[extractor] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
