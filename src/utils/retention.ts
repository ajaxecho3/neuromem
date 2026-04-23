/**
 * retention.ts — Ebbinghaus forgetting curve utilities
 *
 * Stability grows with recall frequency. Retention decays exponentially
 * relative to stability. computeStability and computeRetention are pure;
 * shouldForgetByRetention and withRetention accept an injectable `now` timestamp.
 */

import type { Memory } from "../types/index.js";
import { config } from "./config.js";

/**
 * Compute memory stability — how resistant the memory is to decay.
 *
 * S = importance × (1 + ln(1 + access_count)) × (1 + consolidation_level)
 *
 * A memory with importance=0.5, access_count=0, consolidation_level=0
 * has S=0.5. The same memory recalled 10 times has S ≈ 1.2.
 */
export function computeStability(
  importance: number,
  access_count: number,
  consolidation_level: number,
): number {
  return (
    importance * (1 + Math.log1p(access_count)) * (1 + consolidation_level)
  );
}

/**
 * Compute retention fraction [0, 1] using the Ebbinghaus forgetting curve.
 *
 * R = e^(-Δt / (S × k))
 *
 * @param stability   Result of computeStability()
 * @param daysSinceAccess  Days elapsed since last_accessed (or creation)
 * @param k           Scale constant in days (default: RETENTION_SCALE_DAYS)
 */
export function computeRetention(
  stability: number,
  daysSinceAccess: number,
  k = config.cognition.retentionScaleDays,
): number {
  // Guard: if stability is effectively zero, retention is ~0
  const s = Math.max(stability, 1e-6);
  return Math.exp(-daysSinceAccess / (s * k));
}

/**
 * Triple-condition forget check — all three must be true:
 *   1. Retention < 0.1  (Ebbinghaus — nearly forgotten)
 *   2. importance < 0.2 (low baseline importance)
 *   3. days since last access > 30 (not recently used)
 *
 * Only applies to episodic / affective memories.
 * Working memory is TTL-managed by Redis. Semantic/procedural don't decay.
 */
export function shouldForgetByRetention(
  m: Memory,
  k = config.cognition.retentionScaleDays,
  now = Date.now(),
): boolean {
  if (m.type !== "episodic" && m.type !== "affective") return false;

  const lastAccessed = m.last_accessed ?? m.timestamp;
  const daysSince =
    (now - new Date(lastAccessed).getTime()) / (1000 * 60 * 60 * 24);

  const stability = computeStability(
    m.importance,
    m.access_count,
    m.consolidation_level,
  );
  const retention = computeRetention(stability, daysSince, k);

  return retention < 0.1 && m.importance < 0.2 && daysSince > 30;
}

/**
 * Compute and attach a retention score to a memory object.
 * Returns a new object — does not mutate the original.
 */
export function withRetention(m: Memory, k?: number, now = Date.now()): Memory {
  const lastAccessed = m.last_accessed ?? m.timestamp;
  const daysSince =
    (now - new Date(lastAccessed).getTime()) / (1000 * 60 * 60 * 24);
  const stability = computeStability(
    m.importance,
    m.access_count,
    m.consolidation_level,
  );
  return { ...m, retention: computeRetention(stability, daysSince, k) };
}
