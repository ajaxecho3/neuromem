/**
 * Token counting — uses js-tiktoken for GPT-style BPE encodings as a
 * defensible proxy for "how many tokens will an LLM bill for this string".
 *
 *   cl100k_base  — GPT-3.5, GPT-4, GPT-4-turbo, Claude (best public proxy)
 *   o200k_base   — GPT-4o, GPT-4o-mini, o1, o3, o4, gpt-5 family
 *
 * The encoder is lazily initialized and cached per-encoding, so swapping
 * between encodings in a single process (e.g. A/B testing models) is cheap.
 *
 * Selection order for the "active" encoding:
 *   1. explicit arg to countTokens(text, encoding)
 *   2. TOKENIZER_ENCODING env var (exact match, lowercased)
 *   3. inferred from INNER_THOUGHT_MODEL via model-family rules
 *   4. cl100k_base (safe default — covers GPT-3.5/4 and works as a Claude proxy)
 *
 * If js-tiktoken can't load the rank table for some reason (offline install,
 * unknown encoding name), we degrade to a chars/4 heuristic so nothing crashes.
 */
import { Tiktoken } from "js-tiktoken/lite";
// Rank tables are shipped with js-tiktoken — no network fetch at runtime.
import cl100k_base from "js-tiktoken/ranks/cl100k_base";
import o200k_base from "js-tiktoken/ranks/o200k_base";

/** Encodings we know how to count. Keep in sync with the imports above. */
export type Encoding = "cl100k_base" | "o200k_base";

const RANKS: Record<Encoding, typeof cl100k_base> = {
  cl100k_base,
  o200k_base,
};

const _encoders = new Map<Encoding, Tiktoken>();
let _fallback = false;

function getEncoder(enc: Encoding): Tiktoken | null {
  const cached = _encoders.get(enc);
  if (cached) return cached;
  try {
    const created = new Tiktoken(RANKS[enc]);
    _encoders.set(enc, created);
    return created;
  } catch (err) {
    // Flag the fallback once per process; subsequent calls go straight to the heuristic.
    if (!_fallback) {
      console.warn(
        `[tokens] tiktoken unavailable for ${enc}, falling back to chars/4 heuristic: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    _fallback = true;
    return null;
  }
}

/** Rough heuristic used if tiktoken is unavailable. ~3.5–4 chars per token for English. */
function approxCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Decide which encoding to use based on the model name.
 *
 * The rules are conservative: anything we don't recognize gets cl100k_base,
 * which is a reasonable proxy for Claude and Llama-family models and the
 * exact tokenizer for GPT-3.5/4. We only upgrade to o200k for the OpenAI
 * model families that actually use it.
 */
export function encodingForModel(model: string | undefined | null): Encoding {
  if (!model) return "cl100k_base";
  const m = model.toLowerCase();

  // OpenAI families that ship with o200k_base:
  //   gpt-4o, gpt-4o-mini, gpt-4.1-*, o1, o1-mini, o3, o3-mini, o4*, gpt-5*
  // We match on the leading identifier so minor version strings still work.
  if (
    m.startsWith("gpt-4o") ||
    m.startsWith("gpt-4.1") ||
    m.startsWith("gpt-5") ||
    /^o[134](-|$)/.test(m) ||
    m.startsWith("o4-")
  ) {
    return "o200k_base";
  }

  // Everything else — Claude, Llama, Mistral, Gemma, GPT-3.5/4, Ollama
  // models — use cl100k as the closest public proxy.
  return "cl100k_base";
}

/**
 * The encoding currently selected for this process, based on env vars.
 *
 * Memoized — the result doesn't change without a restart, and tiktoken
 * initialization gets called on the hot path.
 */
let _activeEncoding: Encoding | null = null;

export function getActiveEncoding(): Encoding {
  if (_activeEncoding) return _activeEncoding;

  // Explicit override wins. Accept either exact key or case-insensitive.
  const override = process.env.TOKENIZER_ENCODING?.toLowerCase();
  if (override === "cl100k_base" || override === "o200k_base") {
    _activeEncoding = override;
    return _activeEncoding;
  }
  if (override) {
    console.warn(
      `[tokens] TOKENIZER_ENCODING="${override}" not recognized — ignoring. ` +
        `Valid values: cl100k_base, o200k_base.`,
    );
  }

  _activeEncoding = encodingForModel(process.env.INNER_THOUGHT_MODEL);
  return _activeEncoding;
}

/** For tests — reset the memoized choice so env changes take effect. */
export function _resetActiveEncoding(): void {
  _activeEncoding = null;
}

/**
 * Count tokens in a single string. Returns 0 for empty/undefined input.
 *
 * When `encoding` is omitted, uses the process-active encoding
 * (see getActiveEncoding).
 */
export function countTokens(
  text: string | null | undefined,
  encoding?: Encoding,
): number {
  if (!text) return 0;
  const enc = getEncoder(encoding ?? getActiveEncoding());
  if (!enc) return approxCount(text);
  try {
    return enc.encode(text).length;
  } catch {
    return approxCount(text);
  }
}

/** Sum tokens across many strings. Short-circuits on empty input. */
export function sumTokens(
  texts: Iterable<string | null | undefined>,
  encoding?: Encoding,
): number {
  let total = 0;
  for (const t of texts) total += countTokens(t, encoding);
  return total;
}

/**
 * True when the heuristic fallback is currently in use. The UI can show
 * a small "estimated" badge when this is true.
 */
export function isTokenizerFallback(): boolean {
  // Touch the encoder so the flag gets set on first use.
  getEncoder(getActiveEncoding());
  return _fallback;
}
