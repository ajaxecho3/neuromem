/**
 * Thin HTTP client for the NeuroMem REST API.
 *
 * Only covers what the benchmark needs: remember + recall + health.
 * We deliberately hit the real `/tools/*` endpoints so the benchmark
 * exercises the same code path a real agent would.
 */

import type { Memory, MemoryType } from "../types/index.js";
import type { BenchMemory } from "./types.js";

export class BenchClient {
  constructor(private readonly baseUrl: string) {}

  async health(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) {
      throw new Error(
        `Health check failed: ${res.status} ${res.statusText}. ` +
          `Is NeuroMem running at ${this.baseUrl}? Try: docker compose up -d`,
      );
    }
  }

  /** Seed a single memory; returns the DB id. */
  async remember(
    input: BenchMemory,
    agentId: string,
  ): Promise<{ id: string; type: MemoryType }> {
    const body = {
      content: input.content,
      agent_id: agentId,
      type: input.type,
      title: input.title,
      tags: input.tags,
      importance: input.importance,
      valence: input.valence,
      arousal: input.arousal,
      shared: input.shared,
    };

    const res = await this.post("/tools/remember", body);
    const parsed = res.result as { id: string; type: MemoryType };
    if (!parsed?.id) {
      throw new Error(
        `remember() returned no id for bench_id=${input.bench_id}: ${JSON.stringify(res)}`,
      );
    }
    return { id: parsed.id, type: parsed.type };
  }

  /** Fire a recall. Returns the ordered list of memories. */
  async recall(
    query: string,
    agentId: string,
    opts: {
      type?: MemoryType | MemoryType[];
      limit?: number;
      min_importance?: number;
      tags?: string[];
    } = {},
  ): Promise<{ memories: Memory[]; latencyMs: number }> {
    const started = performance.now();
    const res = await this.post("/tools/recall", {
      query,
      agent_id: agentId,
      type: opts.type,
      limit: opts.limit,
      min_importance: opts.min_importance,
      tags: opts.tags,
      // include_shared defaults to true server-side; we keep that for now
    });
    const latencyMs = performance.now() - started;
    const parsed = res.result as { memories?: Memory[] };
    return { memories: parsed.memories ?? [], latencyMs };
  }

  private async post(path: string, body: unknown): Promise<{ ok: boolean; result: unknown; error?: string }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: { ok: boolean; result: unknown; error?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `${path} returned non-JSON: ${res.status} ${text.slice(0, 200)}`,
      );
    }
    if (!res.ok || parsed.ok === false) {
      throw new Error(
        `${path} failed: ${res.status} ${parsed.error ?? text.slice(0, 200)}`,
      );
    }
    return parsed;
  }
}
