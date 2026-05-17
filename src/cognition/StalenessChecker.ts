/**
 * StalenessChecker — validates memory freshness against source files
 *
 * Given a set of recalled memories, classifies each as:
 *   fresh   — source file unchanged since memory was created
 *   stale   — source file changed or deleted
 *   unknown — no source_hash (legacy memories) → treated as fresh
 *
 * Never blocks recall — staleness is metadata layered on top of results.
 * All file reads run in parallel and are deduplicated by path.
 */

import type { Memory } from "../types/index.js";
import { computeHash } from "../utils/SourceHasher.js";
import { join, resolve } from "node:path";

// ─── Types ────────────────────────────────────────────────────────

export type StaleReason = "file_changed" | "file_deleted";

export interface StaleMemory extends Memory {
  stale_reason: StaleReason;
  current_hash: string | null;
}

export interface StalenessReport {
  /** Memories whose source file hash still matches — safe to inject */
  fresh: Memory[];
  /** Memories whose source file changed or was deleted */
  stale: StaleMemory[];
  /** Memories with no source_hash (legacy) — treated as fresh conservatively */
  unknown: Memory[];
  /** Deduplicated list of files that changed — for re-analysis signal */
  stale_files: string[];
}

// ─── Main export ──────────────────────────────────────────────────

/**
 * Check staleness of a set of memories against the current filesystem.
 *
 * @param memories    Recalled memories to check
 * @param projectRoot Absolute path to project root for resolving source_file paths
 * @returns StalenessReport — never throws
 */
export async function checkStaleness(
  memories: Memory[],
  projectRoot: string,
): Promise<StalenessReport> {
  const fresh: Memory[] = [];
  const stale: StaleMemory[] = [];
  const unknown: Memory[] = [];

  // ── Deduplicate file reads ─────────────────────────────────────
  // Collect unique source files that need hashing, then hash in parallel.
  const filesToHash = new Set<string>();
  for (const m of memories) {
    if (m.source_file && m.source_hash) {
      filesToHash.add(m.source_file);
    }
  }

  // Hash all unique files in parallel
  const hashResults = new Map<string, string | null>();
  await Promise.all(
    [...filesToHash].map(async (relPath) => {
      const absolutePath = resolve(join(projectRoot, relPath));
      const hash = await computeHash(absolutePath).catch(() => null);
      hashResults.set(relPath, hash);
    }),
  );

  // ── Classify each memory ───────────────────────────────────────
  for (const m of memories) {
    // No source tracking → unknown (conservative: treat as fresh)
    if (!m.source_file || !m.source_hash) {
      unknown.push(m);
      continue;
    }

    const currentHash = hashResults.get(m.source_file) ?? null;

    if (currentHash === null) {
      // File was deleted
      stale.push({ ...m, stale_reason: "file_deleted", current_hash: null });
    } else if (currentHash !== m.source_hash) {
      // File content changed
      stale.push({ ...m, stale_reason: "file_changed", current_hash: currentHash });
    } else {
      // Hash matches — still fresh
      fresh.push(m);
    }
  }

  // Deduplicated list of files that need re-analysis
  const stale_files = [...new Set(stale.map((m) => m.source_file!))];

  return { fresh, stale, unknown, stale_files };
}
