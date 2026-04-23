/**
 * MemoryStore — The core file-based memory engine
 *
 * Memories are stored as individual .md files with YAML frontmatter.
 * Each memory type lives in its own subdirectory (see utils/fs.ts).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { nanoid } from 'nanoid';

import type {
  Memory,
  MemoryFrontmatter,
  MemoryType,
  RecallQuery,
  RecallResult,
} from '../types/index.js';
import {
  MEMORY_ROOT,
  atomicWrite,
  listMarkdownFiles,
  memoryPath,
  typeDir,
} from '../utils/fs.js';
import { IndexManager } from './IndexManager.js';

export interface WriteMemoryInput {
  type: MemoryType;
  content: string;
  title?: string;
  agent_id: string;
  tags?: string[];
  importance?: number;
  valence?: 'positive' | 'negative' | 'neutral';
  arousal?: number;
  topic?: string;
  associations?: string[];
  derived_from?: string[];
  source?: string;
}

export class MemoryStore {
  private index: IndexManager;

  constructor(private root: string = MEMORY_ROOT) {
    this.index = new IndexManager(root);
  }

  async init(): Promise<void> {
    await this.index.load();
  }

  // ───────────────────────────────────────────────────────────────
  // WRITE
  // ───────────────────────────────────────────────────────────────

  async write(input: WriteMemoryInput): Promise<Memory> {
    const now = new Date().toISOString();
    const id = `mem_${nanoid(10)}`;
    const title = input.title ?? this.deriveTitle(input.content);

    const frontmatter: MemoryFrontmatter = {
      id,
      type: input.type,
      agent_id: input.agent_id,
      timestamp: now,
      title,
      tags: input.tags ?? [],
      importance: clamp(input.importance ?? 0.5, 0, 1),
      valence: input.valence ?? 'neutral',
      arousal: clamp(input.arousal ?? 0.3, 0, 1),
      access_count: 0,
      last_accessed: now,
      consolidation_level: 0,
      decay_rate: this.defaultDecayRate(input.type),
      associations: input.associations ?? [],
      derived_from: input.derived_from ?? [],
      source: input.source,
      topic: input.topic,
    };

    const filepath = memoryPath({
      type: input.type,
      agent_id: input.agent_id,
      timestamp: now,
      title,
      topic: input.topic,
      id,
    });

    const fileContents = matter.stringify(input.content, frontmatter);
    await atomicWrite(filepath, fileContents);

    await this.index.add(frontmatter, filepath);

    return { frontmatter, content: input.content, filepath };
  }

  // ───────────────────────────────────────────────────────────────
  // READ
  // ───────────────────────────────────────────────────────────────

  async readById(id: string): Promise<Memory | null> {
    const entry = this.index.getMetadata(id);
    if (!entry) return null;
    return this.readFile(entry.filepath);
  }

  async readFile(filepath: string): Promise<Memory | null> {
    try {
      const raw = await fs.readFile(filepath, 'utf8');
      const parsed = matter(raw);
      return {
        frontmatter: parsed.data as MemoryFrontmatter,
        content: parsed.content.trim(),
        filepath,
      };
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  // ───────────────────────────────────────────────────────────────
  // RECALL — keyword + metadata filtering
  // ───────────────────────────────────────────────────────────────

  async recall(query: RecallQuery): Promise<RecallResult> {
    const types: MemoryType[] = query.type
      ? (Array.isArray(query.type) ? query.type : [query.type])
      : ['working', 'episodic', 'semantic', 'procedural', 'affective'];

    if (query.include_shared) types.push('shared');

    // Collect candidate files
    const candidateFiles: string[] = [];
    for (const type of types) {
      const dir = typeDir(type, query.agent_id);
      candidateFiles.push(...(await listMarkdownFiles(dir)));
    }

    // Tag-based pre-filter if tags provided
    let candidates: Memory[] = [];
    for (const file of candidateFiles) {
      const mem = await this.readFile(file);
      if (!mem) continue;
      if (!this.passesFilters(mem, query)) continue;
      candidates.push(mem);
    }

    // Score by keyword relevance
    const scored = candidates
      .map((m) => ({ mem: m, score: this.scoreKeyword(m, query.query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    const limit = query.limit ?? 10;
    const picked = scored.slice(0, limit).map((x) => x.mem);

    // Bump access counts for retrieved memories
    for (const mem of picked) {
      await this.touch(mem);
    }

    return {
      memories: picked,
      strategy: query.tags?.length ? 'tag' : 'keyword',
      scanned: candidateFiles.length,
    };
  }

  // ───────────────────────────────────────────────────────────────
  // UPDATE — touch (bump access), associate, consolidate
  // ───────────────────────────────────────────────────────────────

  async touch(memory: Memory): Promise<void> {
    memory.frontmatter.access_count += 1;
    memory.frontmatter.last_accessed = new Date().toISOString();
    const contents = matter.stringify(memory.content, memory.frontmatter);
    await atomicWrite(memory.filepath, contents);
    await this.index.update(memory.frontmatter, memory.filepath);
  }

  async associate(id_a: string, id_b: string): Promise<void> {
    const a = await this.readById(id_a);
    const b = await this.readById(id_b);
    if (!a || !b) throw new Error('One or both memories not found');

    if (!a.frontmatter.associations.includes(id_b)) {
      a.frontmatter.associations.push(id_b);
      await atomicWrite(a.filepath, matter.stringify(a.content, a.frontmatter));
    }
    if (!b.frontmatter.associations.includes(id_a)) {
      b.frontmatter.associations.push(id_a);
      await atomicWrite(b.filepath, matter.stringify(b.content, b.frontmatter));
    }
    await this.index.linkAssociation(id_a, id_b);
  }

  async forget(id: string): Promise<boolean> {
    const entry = this.index.getMetadata(id);
    if (!entry) return false;
    try {
      await fs.unlink(entry.filepath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
    await this.index.remove(id);
    return true;
  }

  // ───────────────────────────────────────────────────────────────
  // LIST / BROWSE
  // ───────────────────────────────────────────────────────────────

  async listByType(type: MemoryType, agent_id?: string): Promise<Memory[]> {
    const dir = typeDir(type, agent_id);
    const files = await listMarkdownFiles(dir);
    const memories: Memory[] = [];
    for (const f of files) {
      const m = await this.readFile(f);
      if (m) memories.push(m);
    }
    return memories;
  }

  async getAllForConsolidation(agent_id: string): Promise<Memory[]> {
    // Working + episodic memories eligible for consolidation
    const working = await this.listByType('working', agent_id);
    const episodic = await this.listByType('episodic', agent_id);
    return [...working, ...episodic].filter(
      (m) => m.frontmatter.consolidation_level < 1
    );
  }

  // ───────────────────────────────────────────────────────────────
  // HELPERS
  // ───────────────────────────────────────────────────────────────

  private passesFilters(m: Memory, q: RecallQuery): boolean {
    const fm = m.frontmatter;
    if (q.agent_id && fm.agent_id !== q.agent_id && fm.type !== 'shared') {
      return false;
    }
    if (q.min_importance !== undefined && fm.importance < q.min_importance) {
      return false;
    }
    if (q.time_range?.from && fm.timestamp < q.time_range.from) return false;
    if (q.time_range?.to && fm.timestamp > q.time_range.to) return false;
    if (q.tags?.length) {
      const hasAny = q.tags.some((t) => fm.tags.includes(t));
      if (!hasAny) return false;
    }
    return true;
  }

  private scoreKeyword(m: Memory, query: string): number {
    if (!query || !query.trim()) return 1; // no query = everything matches equally
    const q = query.toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const haystack = (
      m.content + ' ' + m.frontmatter.title + ' ' + m.frontmatter.tags.join(' ')
    ).toLowerCase();

    let score = 0;
    for (const term of terms) {
      const count = haystack.split(term).length - 1;
      score += count;
    }
    // Boost by importance + recency
    const ageMs = Date.now() - new Date(m.frontmatter.timestamp).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const recencyBoost = Math.exp(-ageDays * (m.frontmatter.decay_rate ?? 0.01));
    return score * (0.5 + m.frontmatter.importance) * (0.5 + recencyBoost);
  }

  private deriveTitle(content: string): string {
    const firstLine = content.trim().split('\n')[0] ?? 'untitled';
    return firstLine.replace(/^#+\s*/, '').slice(0, 80);
  }

  private defaultDecayRate(type: MemoryType): number {
    // Per-day decay: working memory fades fast, semantic is stable
    switch (type) {
      case 'working': return 0.5;
      case 'episodic': return 0.05;
      case 'affective': return 0.02;
      case 'semantic': return 0.005;
      case 'procedural': return 0.005;
      case 'shared': return 0.01;
    }
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
