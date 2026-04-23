/**
 * LLMProvider — Pluggable LLM reasoning interface
 *
 * Adapters: Ollama (local), OpenAI, Anthropic, Noop (heuristic-only fallback).
 * Selected via LLM_PROVIDER env var.
 */

export interface LLMProvider {
  reason(prompt: string): Promise<string | null>;
}

// ─── Noop (no LLM — heuristics only) ────────────────────────────
export class NoopProvider implements LLMProvider {
  async reason(_prompt: string): Promise<string | null> {
    return null;
  }
}

// ─── Ollama ──────────────────────────────────────────────────────
export class OllamaProvider implements LLMProvider {
  constructor(
    private readonly url: string,
    private readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  async reason(prompt: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt, stream: false }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { response: string };
      return data.response?.trim() ?? null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── OpenAI ──────────────────────────────────────────────────────
export class OpenAIProvider implements LLMProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  async reason(prompt: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 200,
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        choices: { message: { content: string } }[];
      };
      return data.choices[0]?.message?.content?.trim() ?? null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Anthropic ───────────────────────────────────────────────────
export class AnthropicProvider implements LLMProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  async reason(prompt: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 200,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        content: { type: string; text: string }[];
      };
      return data.content?.[0]?.text?.trim() ?? null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
