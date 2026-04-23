/**
 * WorkingStore — Prefrontal Cortex analog (Redis)
 *
 * Short-lived, fast-access memory for the current session. Uses
 * Redis TTL for automatic decay — the "7±2 items" of working memory
 * is approximated via a bounded per-agent list.
 */

import Redis from 'ioredis';
import { nanoid } from 'nanoid';
import type { Memory, WriteMemoryInput, RecallQuery } from '../types/index.js';
import { config } from '../utils/config.js';

const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour
const MAX_ITEMS_PER_AGENT = 20;      // hard cap on working memory slots

export class WorkingStore {
  private redis: Redis;

  constructor() {
    this.redis = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      lazyConnect: true,
    });
  }

  async init(): Promise<void> {
    await this.redis.connect();
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  async write(input: WriteMemoryInput): Promise<Memory> {
    const id = `wrk_${nanoid(10)}`;
    const now = new Date().toISOString();
    const title = input.title ?? input.content.split('\n')[0]?.slice(0, 80) ?? 'untitled';
    const ttl = input.ttl_seconds ?? DEFAULT_TTL_SECONDS;

    const memory: Memory = {
      id,
      type: 'working',
      agent_id: input.agent_id,
      title,
      content: input.content,
      timestamp: now,
      last_accessed: now,
      access_count: 0,
      importance: input.importance ?? 0.4,
      valence: input.valence ?? 'neutral',
      arousal: input.arousal ?? 0.3,
      consolidation_level: 0,
      decay_rate: 0.5,
      tags: input.tags ?? [],
      source: input.source,
      shared: false,
    };

    const key = this.memKey(id);
    const listKey = this.listKey(input.agent_id);

    // Store memory + push to agent's list
    await this.redis
      .multi()
      .set(key, JSON.stringify(memory), 'EX', ttl)
      .lpush(listKey, id)
      .ltrim(listKey, 0, MAX_ITEMS_PER_AGENT - 1)
      .expire(listKey, ttl)
      .exec();

    return memory;
  }

  async readById(id: string): Promise<Memory | null> {
    const raw = await this.redis.get(this.memKey(id));
    if (!raw) return null;
    return JSON.parse(raw) as Memory;
  }

  async recall(query: RecallQuery): Promise<Memory[]> {
    const ids = await this.redis.lrange(this.listKey(query.agent_id), 0, -1);
    if (ids.length === 0) return [];

    const raws = await this.redis.mget(...ids.map((id) => this.memKey(id)));
    const memories: Memory[] = [];
    for (const raw of raws) {
      if (!raw) continue;
      memories.push(JSON.parse(raw) as Memory);
    }

    // Filter + keyword score
    const q = query.query.toLowerCase();
    const scored = memories
      .filter((m) => {
        if (query.min_importance !== undefined && m.importance < query.min_importance) return false;
        if (query.tags?.length && !query.tags.some((t) => m.tags.includes(t))) return false;
        return true;
      })
      .map((m) => ({ m, score: this.keywordScore(m, q) }))
      .filter((x) => !q || x.score > 0)
      .sort((a, b) => b.score - a.score);

    // Bump access counts
    const picked = scored.slice(0, query.limit ?? 10).map((x) => x.m);
    for (const m of picked) {
      m.access_count += 1;
      m.last_accessed = new Date().toISOString();
      await this.redis.set(this.memKey(m.id), JSON.stringify(m), 'KEEPTTL');
    }

    return picked;
  }

  async forget(id: string): Promise<boolean> {
    const n = await this.redis.del(this.memKey(id));
    return n > 0;
  }

  async listByAgent(agent_id: string): Promise<Memory[]> {
    const ids = await this.redis.lrange(this.listKey(agent_id), 0, -1);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(...ids.map((id) => this.memKey(id)));
    return raws.filter(Boolean).map((r) => JSON.parse(r!) as Memory);
  }

  async countByAgent(agent_id: string): Promise<number> {
    return this.redis.llen(this.listKey(agent_id));
  }

  // ─── Helpers ─────────────────────────────────────────────────

  private memKey(id: string): string {
    return `nm:wm:mem:${id}`;
  }

  private listKey(agent_id: string): string {
    return `nm:wm:list:${agent_id}`;
  }

  private keywordScore(m: Memory, q: string): number {
    if (!q) return 1;
    const haystack = (m.title + ' ' + m.content + ' ' + m.tags.join(' ')).toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    let score = 0;
    for (const t of terms) score += haystack.split(t).length - 1;
    return score;
  }
}
