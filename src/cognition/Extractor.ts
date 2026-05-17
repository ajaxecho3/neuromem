/**
 * Extractor — post-turn memory extraction pipeline
 *
 * After each LLM response, this module automatically mines the exchange
 * for memories worth keeping. It runs in the background — never blocking
 * the response to the caller.
 *
 * Pipeline:
 *   1. Call InnerThought with an extraction prompt
 *   2. Apply quality gates (importance, length, dedup, per-turn cap)
 *   3. Store survivors via MemoryManager.rememberBatch()
 *   4. Fallback to regex extraction if InnerThought is unavailable
 */

import type { MemoryManager } from "../stores/MemoryManager.js";
import type { InnerThought } from "./InnerThought.js";
import type { WriteMemoryInput, MemoryType } from "../types/index.js";
import { hashFromRelative, detectProjectRootAsync } from "../utils/SourceHasher.js";

// ─── Types ────────────────────────────────────────────────────────

interface ExtractedItem {
  content: string;
  type: MemoryType;
  importance: number;
  tags: string[];
  source_file?: string | null;
}

export interface ExtractionResult {
  extracted: number;
  skipped: number;
  fallback: boolean;
}

// ─── Constants ────────────────────────────────────────────────────

/** Minimum importance score to store a memory (0–1) */
const MIN_IMPORTANCE = 0.3;

/** Minimum character length for a memory to be useful */
const MIN_CONTENT_LENGTH = 20;

/** Max memories stored per conversation turn (prevents flooding) */
const MAX_PER_TURN = 5;

/** Timeout for the InnerThought extraction call (ms) */
const EXTRACTION_TIMEOUT_MS = 3000;

/** Regex patterns for the fallback extraction pass */
const FALLBACK_PATTERNS = [
  /\b(?:decided?|decision)\b.{10,}/gi,
  /\b(?:will|won't|always|never)\b.{10,}/gi,
  /\bimportant(?:ly)?\b.{10,}/gi,
  /\bremember\b.{10,}/gi,
  /\bprefer(?:s|red)?\b.{10,}/gi,
];

// ─── Extraction prompt ────────────────────────────────────────────

function buildExtractionPrompt(
  userMessage: string,
  assistantResponse: string,
): string {
  return `You are a memory extraction system for an AI agent.

Given the conversation turn below, identify facts, decisions, preferences, or context that would be genuinely useful to remember in future sessions.

Return ONLY a JSON array — no explanation, no markdown, no wrapper. Each item must have:
  { "content": string, "type": "episodic"|"semantic"|"procedural"|"affective"|"working", "importance": 0.0-1.0, "tags": string[], "source_file": string|null }

Rules:
- Return [] if nothing is worth storing
- Prefer concrete, specific facts over vague observations
- "importance" 0.8–1.0 = critical; 0.5–0.8 = useful; 0.3–0.5 = borderline; below 0.3 = skip
- Working memory type = only if explicitly short-term ("today", "this session", "right now")
- "source_file" = relative file path if the memory is about a specific file or code location (e.g. "src/auth/token.ts"), otherwise null
- Max 5 items

Conversation:
User: ${userMessage.slice(0, 800)}
Assistant: ${assistantResponse.slice(0, 1200)}`;
}

// ─── Quality gates ────────────────────────────────────────────────

function passesQualityGates(item: ExtractedItem): boolean {
  // Importance threshold
  if (item.importance < MIN_IMPORTANCE) return false;

  // Too short to be meaningful
  if (!item.content || item.content.trim().length < MIN_CONTENT_LENGTH)
    return false;

  // Questions masquerading as facts are noisy
  if (item.content.trim().endsWith("?")) return false;

  return true;
}

// ─── Fallback regex extraction ────────────────────────────────────

function regexFallback(
  userMessage: string,
  assistantResponse: string,
): ExtractedItem[] {
  const combined = `${userMessage}\n${assistantResponse}`;
  const seen = new Set<string>();
  const results: ExtractedItem[] = [];

  for (const pattern of FALLBACK_PATTERNS) {
    const matches = combined.match(pattern) ?? [];
    for (const match of matches) {
      const content = match.trim().slice(0, 300);
      if (seen.has(content) || content.length < MIN_CONTENT_LENGTH) continue;
      seen.add(content);
      results.push({
        content,
        type: "semantic",
        importance: 0.5,
        tags: ["auto-extracted-fallback"],
      });
      if (results.length >= MAX_PER_TURN) break;
    }
    if (results.length >= MAX_PER_TURN) break;
  }

  return results;
}

// ─── Main export ─────────────────────────────────────────────────

/**
 * Extract memories from a conversation turn and store them.
 *
 * Designed to run fire-and-forget after the LLM response is returned.
 * Never throws — all errors are caught and logged.
 *
 * @returns ExtractionResult with counts, or { extracted: 0, skipped: 0, fallback: false } on failure
 */
export async function extractAndStore(
  agentId: string,
  userMessage: string,
  assistantResponse: string,
  mgr: MemoryManager,
  innerThought?: InnerThought,
  sessionId?: string,
  projectRoot?: string,
): Promise<ExtractionResult> {
  try {
    let items: ExtractedItem[] = [];
    let usedFallback = false;

    // ── Step 1: InnerThought extraction ──────────────────────────
    if (innerThought) {
      const prompt = buildExtractionPrompt(userMessage, assistantResponse);

      const rawResponse = await Promise.race<string | null>([
        innerThought.reason(prompt),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), EXTRACTION_TIMEOUT_MS),
        ),
      ]);

      if (rawResponse) {
        try {
          // Strip markdown code fences if the LLM added them despite instructions
          const cleaned = rawResponse
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/, "")
            .trim();

          const parsed = JSON.parse(cleaned);
          if (Array.isArray(parsed)) {
            items = parsed.filter(
              (item): item is ExtractedItem =>
                typeof item === "object" &&
                typeof item.content === "string" &&
                typeof item.type === "string" &&
                typeof item.importance === "number",
            );
          }
        } catch {
          // Malformed JSON → fall through to regex fallback
        }
      }
    }

    // ── Step 2: Regex fallback if InnerThought unavailable or returned nothing ──
    if (items.length === 0) {
      items = regexFallback(userMessage, assistantResponse);
      usedFallback = items.length > 0;
    }

    if (items.length === 0) {
      return { extracted: 0, skipped: 0, fallback: false };
    }

    // ── Step 3: Quality gates ──────────────────────────────────────
    const passing = items.filter(passesQualityGates).slice(0, MAX_PER_TURN);
    const skipped = items.length - passing.length;

    if (passing.length === 0) {
      return { extracted: 0, skipped, fallback: usedFallback };
    }

    // ── Step 4: Deduplication against recent memories ─────────────
    // We do a lightweight recall for each candidate and skip near-duplicates.
    // Similarity threshold is handled by MemoryManager.remember() internally
    // (it calls findSimilar with a 0.95 threshold), so we can just call
    // rememberBatch and let the dedup logic there handle it.

    // ── Step 4: Resolve source hashes ─────────────────────────────
    // Auto-detect project root if not provided
    const root = projectRoot ?? await detectProjectRootAsync(process.cwd()).catch(() => process.cwd());
    const analyzedAt = new Date().toISOString();

    const inputs: WriteMemoryInput[] = await Promise.all(
      passing.map(async (item) => {
        const sourceFile = item.source_file ?? undefined;
        const sourceHash = sourceFile
          ? (await hashFromRelative(sourceFile, root).catch(() => undefined)) ?? undefined
          : undefined;

        return {
          content: item.content,
          type: item.type,
          importance: item.importance,
          tags: item.tags ?? [],
          agent_id: agentId,
          ...(sessionId ? { session_id: sessionId } : {}),
          created_by: "extractor",
          ...(sourceFile ? { source_file: sourceFile } : {}),
          ...(sourceHash ? { source_hash: sourceHash, analyzed_at: analyzedAt } : {}),
        } satisfies WriteMemoryInput;
      }),
    );

    const batchResult = await mgr.rememberBatch(inputs);

    console.log(
      `[Extractor] agent=${agentId} stored=${batchResult.stored} ` +
        `duplicates=${batchResult.duplicates} skipped=${skipped} fallback=${usedFallback}`,
    );

    return {
      extracted: batchResult.stored,
      skipped: skipped + batchResult.duplicates,
      fallback: usedFallback,
    };
  } catch (err) {
    console.error(
      `[Extractor] agent=${agentId} error:`,
      err instanceof Error ? err.message : String(err),
    );
    return { extracted: 0, skipped: 0, fallback: false };
  }
}
