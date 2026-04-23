/**
 * timeParser.ts — Natural language time expression → ISO time range
 *
 * Resolution order:
 *   1. LLM (InnerThought) — handles arbitrary expressions
 *   2. Regex fallback — handles common patterns deterministically
 *   3. null — expression not parseable; caller skips time_range
 *
 * `now` is injectable for testability.
 */

import type { InnerThought } from "../cognition/InnerThought.js";

export interface TimeRange {
  from?: string;
  to?: string;
}

/**
 * Parse a natural language time expression into an ISO time range.
 *
 * @param expr         The expression to parse, e.g. "last week", "yesterday"
 * @param now          Reference date (defaults to new Date())
 * @param innerThought Optional LLM client — used first before regex fallback
 * @returns            { from?, to? } with ISO strings, or null if unparseable
 */
export async function parseTimeExpression(
  expr: string,
  now = new Date(),
  innerThought?: InnerThought,
): Promise<TimeRange | null> {
  // 1. LLM-first
  if (innerThought) {
    const result = await tryLlmParse(expr, now, innerThought);
    if (result !== null) return result;
  }

  // 2. Regex fallback
  return tryRegexParse(expr, now);
}

// ─── LLM path ────────────────────────────────────────────────────────────────

async function tryLlmParse(
  expr: string,
  now: Date,
  innerThought: InnerThought,
): Promise<TimeRange | null> {
  const prompt = `Convert this time expression to a JSON time range.
Expression: "${expr}"
Current date: ${now.toISOString()}
Rules:
- Respond with ONLY valid JSON, no markdown, no explanation
- Format: {"from": "ISO8601", "to": "ISO8601"}
- Omit "from" if open-ended start, omit "to" if open-ended end
- Return null (the word null, no quotes) if this is not a time expression`;

  const response = await innerThought.reason(prompt);
  if (!response) return null;

  const trimmed = response.trim();
  if (trimmed === "null") return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null) return null;
    if (typeof parsed !== "object" || Array.isArray(parsed)) return null;

    const obj = parsed as Record<string, unknown>;
    const range: TimeRange = {};

    if (typeof obj.from === "string" && isValidIso(obj.from)) {
      range.from = obj.from;
    }
    if (typeof obj.to === "string" && isValidIso(obj.to)) {
      range.to = obj.to;
    }

    // Must have at least one bound to be useful
    if (!range.from && !range.to) return null;
    return range;
  } catch {
    // Malformed JSON — fall through to regex
    return null;
  }
}

function isValidIso(s: string): boolean {
  const d = new Date(s);
  return !isNaN(d.getTime());
}

// ─── Regex fallback ───────────────────────────────────────────────────────────

function tryRegexParse(expr: string, now: Date): TimeRange | null {
  const e = expr.trim().toLowerCase();

  // "today"
  if (/^today$/.test(e)) {
    return { from: startOfDay(now).toISOString(), to: now.toISOString() };
  }

  // "yesterday"
  if (/^yesterday$/.test(e)) {
    const start = startOfDay(addDays(now, -1));
    const end = endOfDay(addDays(now, -1));
    return { from: start.toISOString(), to: end.toISOString() };
  }

  // "this week"
  if (/^this week$/.test(e)) {
    return { from: startOfWeek(now).toISOString(), to: now.toISOString() };
  }

  // "last week"
  if (/^last week$/.test(e)) {
    const prevMonday = startOfWeek(addDays(now, -7));
    const prevSunday = endOfDay(addDays(prevMonday, 6));
    return { from: prevMonday.toISOString(), to: prevSunday.toISOString() };
  }

  // "last N days"
  const lastDays = e.match(/^last (\d+) days?$/);
  if (lastDays) {
    const n = parseInt(lastDays[1], 10);
    return { from: addDays(now, -n).toISOString(), to: now.toISOString() };
  }

  // "last N weeks"
  const lastWeeks = e.match(/^last (\d+) weeks?$/);
  if (lastWeeks) {
    const n = parseInt(lastWeeks[1], 10);
    return { from: addDays(now, -n * 7).toISOString(), to: now.toISOString() };
  }

  // "last N months"
  const lastMonths = e.match(/^last (\d+) months?$/);
  if (lastMonths) {
    const n = parseInt(lastMonths[1], 10);
    return { from: addDays(now, -n * 30).toISOString(), to: now.toISOString() };
  }

  // "past N hours"
  const pastHours = e.match(/^past (\d+) hours?$/);
  if (pastHours) {
    const n = parseInt(pastHours[1], 10);
    const from = new Date(now.getTime() - n * 60 * 60 * 1000);
    return { from: from.toISOString(), to: now.toISOString() };
  }

  return null;
}

// ─── Date helpers (UTC-based) ─────────────────────────────────────────────────

function startOfDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

function endOfDay(d: Date): Date {
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
}

function startOfWeek(d: Date): Date {
  // Week starts Monday (ISO)
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysFromMonday = (day + 6) % 7;
  return startOfDay(addDays(d, -daysFromMonday));
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}
