/**
 * Embedding providers — pluggable text → vector conversion.
 *
 * Default: 'local' — a deterministic hash-based fallback for offline/dev use.
 * Swap in 'openai' or 'voyage' for real semantic search.
 */

import { config } from '../utils/config.js';

export interface EmbeddingProvider {
  name: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

// ─── Local fallback (no external API) ───────────────────────────
// Uses a bag-of-character-ngrams + hashing trick. Not as good as a
// real model but lets everything work without API keys.
class LocalHashEmbedder implements EmbeddingProvider {
  name = 'local-hash';
  dim = 256;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.hashEmbed(t));
  }

  private hashEmbed(text: string): number[] {
    const vec = new Array(this.dim).fill(0);
    const lower = text.toLowerCase();
    // Character 3-grams
    for (let i = 0; i < lower.length - 2; i++) {
      const gram = lower.slice(i, i + 3);
      const h = this.hash(gram);
      vec[h % this.dim] += 1;
    }
    // L2 normalize
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
    return vec.map((x) => x / norm);
  }

  private hash(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
  }
}

// ─── OpenAI provider ────────────────────────────────────────────
class OpenAIEmbedder implements EmbeddingProvider {
  name = 'openai-text-embedding-3-small';
  dim = 1536;

  constructor(private apiKey: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: texts,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI embed failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data.map((d) => d.embedding);
  }
}

// ─── Voyage AI provider ─────────────────────────────────────────
class VoyageEmbedder implements EmbeddingProvider {
  name = 'voyage-3';
  dim = 1024;

  constructor(private apiKey: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'voyage-3', input: texts }),
    });
    if (!res.ok) throw new Error(`Voyage embed failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data.map((d) => d.embedding);
  }
}

// ─── Factory ────────────────────────────────────────────────────
export function createEmbedder(): EmbeddingProvider {
  switch (config.embeddings.provider) {
    case 'openai':
      if (!config.embeddings.openaiKey) {
        console.warn('[embeddings] OPENAI_API_KEY missing, falling back to local');
        return new LocalHashEmbedder();
      }
      return new OpenAIEmbedder(config.embeddings.openaiKey);
    case 'voyage':
      if (!config.embeddings.voyageKey) {
        console.warn('[embeddings] VOYAGE_API_KEY missing, falling back to local');
        return new LocalHashEmbedder();
      }
      return new VoyageEmbedder(config.embeddings.voyageKey);
    case 'local':
    default:
      return new LocalHashEmbedder();
  }
}
