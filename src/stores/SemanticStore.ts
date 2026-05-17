/**
 * SemanticStore — Temporal Cortex analog (ChromaDB)
 *
 * Stores facts, concepts, and learned knowledge as vector embeddings
 * for similarity-based retrieval. Also used for procedural skill
 * descriptions so agents can find "how to do X" by meaning.
 */

import { ChromaClient, type Collection } from "chromadb";
import { nanoid } from "nanoid";
import type { Memory, WriteMemoryInput, RecallQuery } from "../types/index.js";
import { config } from "../utils/config.js";
import { createEmbedder, type EmbeddingProvider } from "../embeddings/index.js";

export class SemanticStore {
  private client: ChromaClient;
  private semantic!: Collection;
  private procedural!: Collection;
  private embedder: EmbeddingProvider;

  constructor() {
    this.client = new ChromaClient({
      path: `http://${config.chroma.host}:${config.chroma.port}`,
      fetchOptions: {
        headers: {
          Authorization: `Bearer ${config.chroma.token}`,
        },
      },
    });
    this.embedder = createEmbedder();
  }

  async init(): Promise<void> {
    this.semantic = await this.client.getOrCreateCollection({
      name: "semantic_memories",
      metadata: { description: "Facts, concepts, and learned knowledge" },
    });
    this.procedural = await this.client.getOrCreateCollection({
      name: "procedural_memories",
      metadata: { description: "Skills, workflows, and how-tos" },
    });
  }

  async write(
    input: WriteMemoryInput & { type?: "semantic" | "procedural" },
  ): Promise<Memory> {
    const type = input.type ?? "semantic";
    const id = `${type === "semantic" ? "sem" : "pro"}_${nanoid(10)}`;
    const now = new Date().toISOString();
    const title =
      input.title ?? input.content.split("\n")[0]?.slice(0, 80) ?? "untitled";
    const collection = type === "semantic" ? this.semantic : this.procedural;

    const [embedding] = await this.embedder.embed([input.content]);

    const metadata = {
      agent_id: input.agent_id,
      title,
      type,
      timestamp: now,
      last_accessed: now,
      access_count: 0,
      importance: clamp01(input.importance ?? 0.6),
      valence: input.valence ?? "neutral",
      arousal: clamp01(input.arousal ?? 0.2),
      consolidation_level: type === "semantic" ? 0.5 : 0,
      decay_rate: 0.005,
      tags: (input.tags ?? []).join(","),
      shared: input.shared ?? false,
      source: input.source ?? "",
      topic: input.topic ?? "",
      created_by: input.created_by ?? "",
      session_id: input.session_id ?? "",
      source_file: input.source_file ?? "",
      source_hash: input.source_hash ?? "",
      analyzed_at: input.analyzed_at ?? "",
    };

    await collection.add({
      ids: [id],
      embeddings: [embedding],
      documents: [input.content],
      metadatas: [metadata],
    });

    return {
      id,
      type,
      agent_id: input.agent_id,
      title,
      content: input.content,
      timestamp: now,
      last_accessed: now,
      access_count: 0,
      importance: metadata.importance,
      valence: metadata.valence,
      arousal: metadata.arousal,
      consolidation_level: metadata.consolidation_level,
      decay_rate: metadata.decay_rate,
      tags: input.tags ?? [],
      source: input.source,
      shared: metadata.shared,
      source_file: input.source_file,
      source_hash: input.source_hash,
      analyzed_at: input.analyzed_at,
    };
  }

  async recall(query: RecallQuery): Promise<Memory[]> {
    // When no type filter is supplied, query BOTH collections. Previously this
    // only hit `semantic`, which meant procedural memories (how-to's) were
    // invisible unless the caller explicitly filtered for them.
    const qt = Array.isArray(query.type)
      ? query.type
      : query.type
        ? [query.type]
        : [];
    const types: ("semantic" | "procedural")[] = [];
    if (qt.length === 0 || qt.includes("semantic")) types.push("semantic");
    if (qt.length === 0 || qt.includes("procedural")) types.push("procedural");

    const [queryEmbedding] = await this.embedder.embed([query.query]);

    const conditions: any[] = [];
    if (query.include_shared) {
      conditions.push({
        $or: [{ agent_id: query.agent_id }, { shared: true }],
      });
    } else {
      conditions.push({ agent_id: query.agent_id });
    }
    if (query.min_importance !== undefined) {
      conditions.push({ importance: { $gte: query.min_importance } });
    }
    const where =
      conditions.length === 1 ? conditions[0] : { $and: conditions };

    // Collect results from every collection with their Chroma distances so we
    // can fuse them by similarity rather than by importance.
    // Each collection gets its own `limit` budget so procedural memories don't
    // get starved out by semantic matches (or vice versa).
    type Scored = { mem: Memory; distance: number };
    const scored: Scored[] = [];
    const perCollectionLimit = query.limit ?? 10;

    for (const type of types) {
      const coll = type === "semantic" ? this.semantic : this.procedural;
      const res = await coll.query({
        queryEmbeddings: [queryEmbedding],
        nResults: perCollectionLimit,
        where,
      });

      const ids = res.ids[0] ?? [];
      const docs = res.documents[0] ?? [];
      const metas = res.metadatas[0] ?? [];
      const dists = res.distances?.[0] ?? [];

      for (let i = 0; i < ids.length; i++) {
        const meta = metas[i] as any;
        const distance = typeof dists[i] === "number" ? (dists[i] as number) : Number.POSITIVE_INFINITY;
        scored.push({
          distance,
          mem: {
            id: ids[i]!,
            type,
            agent_id: meta.agent_id,
            title: meta.title,
            content: docs[i] ?? "",
            timestamp: meta.timestamp,
            last_accessed: new Date().toISOString(),
            access_count: (meta.access_count ?? 0) + 1,
            importance: meta.importance,
            valence: meta.valence,
            arousal: meta.arousal,
            consolidation_level: meta.consolidation_level,
            decay_rate: meta.decay_rate,
            tags: meta.tags ? String(meta.tags).split(",").filter(Boolean) : [],
            source: meta.source || undefined,
            shared: meta.shared,
            source_file: meta.source_file || undefined,
            source_hash: meta.source_hash || undefined,
            analyzed_at: meta.analyzed_at || undefined,
          },
        });
      }
    }

    // Rank by vector similarity (lower distance = closer). Preserving this
    // order is what lets callers (MemoryManager) do rank-based fusion like RRF.
    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, query.limit ?? 10).map((s) => s.mem);
  }

  /** List memories without embedding search — for browse/pagination use cases */
  async list(opts: {
    agent_id: string;
    types?: ("semantic" | "procedural")[];
    limit?: number;
    min_importance?: number;
    include_shared?: boolean;
  }): Promise<Memory[]> {
    const types = opts.types ?? ["semantic", "procedural"];
    const limit = opts.limit ?? 100;
    const results: Memory[] = [];

    for (const type of types) {
      const coll = type === "semantic" ? this.semantic : this.procedural;

      const conditions: any[] = [];
      if (opts.include_shared) {
        conditions.push({
          $or: [{ agent_id: opts.agent_id }, { shared: true }],
        });
      } else {
        conditions.push({ agent_id: opts.agent_id });
      }
      if (opts.min_importance !== undefined) {
        conditions.push({ importance: { $gte: opts.min_importance } });
      }
      const where =
        conditions.length === 1 ? conditions[0] : { $and: conditions };

      const res = await coll.get({
        where,
        limit,
        include: ["documents", "metadatas"] as any,
      });

      for (let i = 0; i < res.ids.length; i++) {
        const meta = res.metadatas[i] as any;
        results.push({
          id: res.ids[i]!,
          type,
          agent_id: meta.agent_id,
          title: meta.title,
          content: res.documents[i] ?? "",
          timestamp: meta.timestamp,
          last_accessed: meta.last_accessed,
          access_count: Number(meta.access_count ?? 0),
          importance: Number(meta.importance ?? 0.6),
          valence: meta.valence ?? "neutral",
          arousal: Number(meta.arousal ?? 0.2),
          consolidation_level: Number(meta.consolidation_level ?? 0.5),
          decay_rate: Number(meta.decay_rate ?? 0.005),
          tags: meta.tags ? String(meta.tags).split(",").filter(Boolean) : [],
          source: meta.source || undefined,
          shared: Boolean(meta.shared),
          source_file: meta.source_file || undefined,
          source_hash: meta.source_hash || undefined,
          analyzed_at: meta.analyzed_at || undefined,
        });
      }
    }

    results.sort((a, b) => b.importance - a.importance);
    return results.slice(0, limit);
  }

  async forget(id: string): Promise<boolean> {
    const coll = id.startsWith("sem_") ? this.semantic : this.procedural;
    try {
      await coll.delete({ ids: [id] });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find a near-duplicate of `content` for a given agent.
   * Uses L2 distance on embeddings; threshold ~0.2 catches near-identical text.
   * Returns the existing Memory if found, null otherwise.
   */
  async findSimilar(
    content: string,
    agentId: string,
    type: "semantic" | "procedural" = "semantic",
    threshold = 0.2,
  ): Promise<Memory | null> {
    const collection = type === "semantic" ? this.semantic : this.procedural;

    // Guard: Chroma throws if you query an empty collection
    const count = await collection.count();
    if (count === 0) return null;

    const [embedding] = await this.embedder.embed([content]);

    const res = await collection.query({
      queryEmbeddings: [embedding],
      nResults: 1,
      where: { agent_id: agentId },
    });

    const distance = res.distances?.[0]?.[0];
    if (distance === undefined || distance > threshold) return null;

    const id = res.ids[0]?.[0];
    if (!id) return null;
    return this.readById(id);
  }

  /**
   * Find semantically related memories that may conflict.
   * Returns memories within a "related but not duplicate" distance band:
   * closer than 0.6 (related topic) but farther than 0.2 (not a duplicate).
   * The caller uses an LLM or heuristic to decide if it's a true conflict.
   */
  async findRelated(
    content: string,
    agentId: string,
    type: "semantic" | "procedural" = "semantic",
    limit = 3,
  ): Promise<Memory[]> {
    const collection = type === "semantic" ? this.semantic : this.procedural;

    const count = await collection.count();
    if (count === 0) return [];

    const [embedding] = await this.embedder.embed([content]);

    const res = await collection.query({
      queryEmbeddings: [embedding],
      nResults: Math.min(limit + 1, count), // +1 to allow filtering the exact match
      where: { agent_id: agentId },
    });

    const ids = res.ids[0] ?? [];
    const distances = res.distances?.[0] ?? [];
    const related: Memory[] = [];

    for (let i = 0; i < ids.length; i++) {
      const d = distances[i];
      if (d === undefined || d <= 0.2 || d > 0.6) continue; // skip dupes and unrelated
      const mem = await this.readById(ids[i]!);
      if (mem) related.push(mem);
      if (related.length >= limit) break;
    }

    return related;
  }

  async readById(id: string): Promise<Memory | null> {
    const collection = id.startsWith("pro_") ? this.procedural : this.semantic;
    try {
      const res = await collection.get({
        ids: [id],
        include: ["documents", "metadatas"] as any,
      });
      if (!res.ids.length) return null;
      const meta = res.metadatas[0] as any;
      const content = res.documents[0] ?? "";
      return {
        id,
        type: (meta.type ?? "semantic") as Memory["type"],
        agent_id: meta.agent_id,
        title: meta.title,
        content,
        timestamp: meta.timestamp,
        last_accessed: meta.last_accessed,
        access_count: Number(meta.access_count ?? 0),
        importance: Number(meta.importance ?? 0.6),
        valence: meta.valence ?? "neutral",
        arousal: Number(meta.arousal ?? 0.2),
        consolidation_level: Number(meta.consolidation_level ?? 0.5),
        decay_rate: Number(meta.decay_rate ?? 0.005),
        tags: meta.tags ? String(meta.tags).split(",").filter(Boolean) : [],
        source: meta.source || undefined,
        shared: Boolean(meta.shared),
        source_file: meta.source_file || undefined,
        source_hash: meta.source_hash || undefined,
        analyzed_at: meta.analyzed_at || undefined,
      };
    } catch {
      return null;
    }
  }

  async countByAgent(
    agent_id: string,
  ): Promise<{ semantic: number; procedural: number }> {
    const s = await this.semantic.count();
    const p = await this.procedural.count();
    // Note: Chroma doesn't filter count(), so this is global — good enough for reflect()
    return { semantic: s, procedural: p };
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
