/**
 * SourceHasher — file hashing with process-scoped cache
 *
 * Computes SHA-256 (first 12 hex chars) of file contents.
 * Results are cached for the lifetime of the process so multiple
 * memories referencing the same file only trigger one disk read.
 *
 * Also provides detectProjectRoot() for auto-detecting the project
 * root when an explicit path is not supplied.
 */

import { createHash } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { accessSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

// ─── Cache ────────────────────────────────────────────────────────

const _cache = new Map<string, string | null>();

/** Reset the cache — for tests only */
export function clearCache(): void {
  _cache.clear();
}

// ─── Core hashing ─────────────────────────────────────────────────

/**
 * Compute a 12-char SHA-256 hex hash of the file at absolutePath.
 * Returns null if the file doesn't exist or can't be read.
 * Result is cached for the process lifetime.
 */
export async function computeHash(absolutePath: string): Promise<string | null> {
  const cached = _cache.get(absolutePath);
  if (cached !== undefined) return cached;

  try {
    const content = await readFile(absolutePath);
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
    _cache.set(absolutePath, hash);
    return hash;
  } catch {
    // File doesn't exist or permission denied
    _cache.set(absolutePath, null);
    return null;
  }
}

/**
 * Convenience: resolve relative path against projectRoot then hash.
 * Returns null if either path is missing or the file can't be read.
 */
export async function hashFromRelative(
  relativePath: string,
  projectRoot: string,
): Promise<string | null> {
  if (!relativePath || !projectRoot) return null;
  const absolute = resolve(join(projectRoot, relativePath));
  return computeHash(absolute);
}

// ─── Project root detection ───────────────────────────────────────

const ROOT_MARKERS = ["package.json", ".git", "Makefile", "pyproject.toml", "go.mod"];
const MAX_WALK_LEVELS = 5;

/**
 * Walk up from startPath looking for a project root marker.
 * Returns the first directory containing any of ROOT_MARKERS,
 * or startPath if none found within MAX_WALK_LEVELS levels.
 */
export function detectProjectRoot(startPath: string): string {
  // If startPath is a file, start from its directory
  let current = startPath;

  for (let i = 0; i < MAX_WALK_LEVELS; i++) {
    for (const marker of ROOT_MARKERS) {
      try {
        accessSync(join(current, marker));
        return current; // found a marker here
      } catch {
        // marker not in this dir, continue
      }
    }
    const parent = dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }

  return startPath; // fallback
}

/**
 * Async version of detectProjectRoot — preferred in async contexts.
 */
export async function detectProjectRootAsync(startPath: string): Promise<string> {
  let current = startPath;

  for (let i = 0; i < MAX_WALK_LEVELS; i++) {
    for (const marker of ROOT_MARKERS) {
      try {
        await access(join(current, marker));
        return current;
      } catch {
        // not here
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return startPath;
}
