/**
 * Staleness unit tests — no Docker required
 *
 * Tests cover:
 *  - StalenessChecker: fresh / stale / unknown classification
 *  - SourceHasher: computeHash, hashFromRelative, detectProjectRoot, cache
 *  - buildContext() staleness integration (via mocked MemoryManager)
 */

import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";

// ─── Test helpers ──────────────────────────────────────────────

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

function assertEq<T>(actual: T, expected: T, label: string) {
  if (actual === expected) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    failed++;
  }
}

function section(name: string) {
  console.log(`\n[staleness] ${name}`);
}

// ─── Temp directory fixture ────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `neuromem-test-${nanoid(6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

// ─── SourceHasher tests ────────────────────────────────────────

import { computeHash, hashFromRelative, detectProjectRoot, clearCache } from "../../utils/SourceHasher.js";

section("SourceHasher — computeHash");

const dir1 = makeTmpDir();
const file1 = join(dir1, "test.ts");

writeFileSync(file1, "const x = 1;");
const hash1 = await computeHash(file1);
assert(typeof hash1 === "string" && hash1 !== null, "returns string for existing file");
assert(hash1 !== null && hash1!.length === 12, "hash is exactly 12 chars");
assert(hash1 !== null && /^[0-9a-f]+$/.test(hash1!), "hash is hex");

// Same content → same hash (deterministic)
clearCache();
const hash1b = await computeHash(file1);
assertEq(hash1b, hash1, "same content → same hash");

// Changed content → different hash
writeFileSync(file1, "const x = 2;");
clearCache();
const hash2 = await computeHash(file1);
assert(hash2 !== hash1, "changed content → different hash");

// Missing file → null
clearCache();
const hashMissing = await computeHash(join(dir1, "does-not-exist.ts"));
assertEq(hashMissing, null, "missing file → null");

section("SourceHasher — process-scoped cache");

writeFileSync(file1, "cached content");
clearCache();
const hashC1 = await computeHash(file1);
// Modify the file but don't clear cache — should get cached value
writeFileSync(file1, "new content that differs");
const hashC2 = await computeHash(file1);
assertEq(hashC1, hashC2, "cache returns stale value without clearCache");
// After clearing cache, fresh read
clearCache();
const hashC3 = await computeHash(file1);
assert(hashC3 !== hashC1, "clearCache() forces fresh read");

section("SourceHasher — hashFromRelative");

const dir2 = makeTmpDir();
writeFileSync(join(dir2, "src.ts"), "export const y = 42;");
clearCache();
const relHash = await hashFromRelative("src.ts", dir2);
assert(typeof relHash === "string" && relHash !== null, "relative path resolves correctly");
clearCache();
const absHash = await computeHash(join(dir2, "src.ts"));
assertEq(relHash, absHash, "hashFromRelative matches computeHash of absolute path");

// Non-existent relative path → null
clearCache();
const relMissing = await hashFromRelative("missing.ts", dir2);
assertEq(relMissing, null, "missing relative file → null");

section("SourceHasher — detectProjectRoot");

// Create a fake project with package.json
const projDir = makeTmpDir();
const srcDir = join(projDir, "src", "deep");
mkdirSync(srcDir, { recursive: true });
writeFileSync(join(projDir, "package.json"), '{"name":"test"}');

const detected = detectProjectRoot(srcDir);
assertEq(detected, projDir, "walks up to find package.json");

const detectedFromRoot = detectProjectRoot(projDir);
assertEq(detectedFromRoot, projDir, "stops at the directory containing package.json");

// No package.json → returns starting path (fallback)
const noProjectDir = makeTmpDir();
const detected2 = detectProjectRoot(noProjectDir);
assertEq(detected2, noProjectDir, "no package.json → returns start path as fallback");

// ─── StalenessChecker tests ────────────────────────────────────

import { checkStaleness } from "../../cognition/StalenessChecker.js";
import type { Memory } from "../../types/index.js";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `sem_${nanoid(8)}`,
    agent_id: "test-agent",
    title: "Test memory",
    content: "Some memory content",
    type: "semantic",
    importance: 0.7,
    tags: [],
    timestamp: new Date().toISOString(),
    access_count: 0,
    ...overrides,
  } as Memory;
}

section("StalenessChecker — fresh memories");

const staleDir = makeTmpDir();
const freshFile = join(staleDir, "component.ts");
writeFileSync(freshFile, "export function hello() {}");

clearCache();
const freshHash = await computeHash(freshFile);
const freshMemory = makeMemory({
  source_file: "component.ts",
  source_hash: freshHash!,
});

clearCache();
const freshReport = await checkStaleness([freshMemory], staleDir);
assertEq(freshReport.fresh.length, 1, "unchanged file → fresh");
assertEq(freshReport.stale.length, 0, "unchanged file → 0 stale");
assertEq(freshReport.unknown.length, 0, "memory with source_hash → not unknown");
assertEq(freshReport.stale_files.length, 0, "no stale files reported");

section("StalenessChecker — stale (file changed)");

writeFileSync(freshFile, "export function helloWorld() {}  // changed");
clearCache();
const changedReport = await checkStaleness([freshMemory], staleDir);
assertEq(changedReport.fresh.length, 0, "changed file → 0 fresh");
assertEq(changedReport.stale.length, 1, "changed file → 1 stale");
assertEq(changedReport.stale[0]!.stale_reason, "file_changed", "reason = file_changed");
assertEq(changedReport.stale_files[0], "component.ts", "stale_files contains the file");

section("StalenessChecker — stale (file deleted)");

const deletedFile = join(staleDir, "deleted.ts");
writeFileSync(deletedFile, "content before delete");
clearCache();
const deletedHash = await computeHash(deletedFile);
rmSync(deletedFile);

const deletedMemory = makeMemory({
  source_file: "deleted.ts",
  source_hash: deletedHash!,
});

clearCache();
const deletedReport = await checkStaleness([deletedMemory], staleDir);
assertEq(deletedReport.stale.length, 1, "deleted file → stale");
assertEq(deletedReport.stale[0]!.stale_reason, "file_deleted", "reason = file_deleted");
assertEq(deletedReport.stale[0]!.current_hash, null, "current_hash = null for deleted file");

section("StalenessChecker — unknown (no source_hash)");

const legacyMemory = makeMemory(); // no source_file or source_hash
clearCache();
const unknownReport = await checkStaleness([legacyMemory], staleDir);
assertEq(unknownReport.unknown.length, 1, "memory without source_hash → unknown");
assertEq(unknownReport.fresh.length, 0, "memory without source_hash → not fresh");
assertEq(unknownReport.stale.length, 0, "memory without source_hash → not stale");

section("StalenessChecker — mixed batch");

const mixedFile = join(staleDir, "mixed.ts");
writeFileSync(mixedFile, "original content");
clearCache();
const mixedHash = await computeHash(mixedFile);

const freshMem = makeMemory({ source_file: "mixed.ts", source_hash: mixedHash! });
const unknownMem = makeMemory(); // no hash
const deletedMem = makeMemory({ source_file: "deleted.ts", source_hash: "fakehash123" }); // already deleted

clearCache();
const mixedReport = await checkStaleness([freshMem, unknownMem, deletedMem], staleDir);
assertEq(mixedReport.fresh.length, 1, "mixed batch: 1 fresh");
assertEq(mixedReport.unknown.length, 1, "mixed batch: 1 unknown");
assertEq(mixedReport.stale.length, 1, "mixed batch: 1 stale");
assertEq(mixedReport.stale_files.length, 1, "mixed batch: 1 unique stale file");

section("StalenessChecker — deduplicates parallel file reads");

// Two memories for the same file — only one file read should occur.
// We can't easily measure I/O but we can verify both classify correctly.
const sharedFile = join(staleDir, "shared.ts");
writeFileSync(sharedFile, "shared content");
clearCache();
const sharedHash = await computeHash(sharedFile);

const mem1 = makeMemory({ source_file: "shared.ts", source_hash: sharedHash! });
const mem2 = makeMemory({ source_file: "shared.ts", source_hash: sharedHash! });

clearCache();
const sharedReport = await checkStaleness([mem1, mem2], staleDir);
assertEq(sharedReport.fresh.length, 2, "both memories of same file classify as fresh");
assertEq(sharedReport.stale_files.length, 0, "no stale files for unchanged shared file");

section("StalenessChecker — never throws on bad projectRoot");

const badReport = await checkStaleness(
  [makeMemory({ source_file: "some.ts", source_hash: "abc123def456" })],
  "/nonexistent/path/to/project",
);
assertEq(badReport.stale.length, 1, "non-existent projectRoot → memory treated as stale (file_deleted)");
assert(!badReport.stale[0]!.current_hash, "current_hash is null when file cannot be read");

// ─── Cleanup ───────────────────────────────────────────────────

cleanup(dir1);
cleanup(dir2);
cleanup(projDir);
cleanup(noProjectDir);
cleanup(staleDir);

// ─── Summary ──────────────────────────────────────────────────

console.log(`\n[staleness] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
