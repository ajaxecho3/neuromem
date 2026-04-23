/**
 * IndexManager — Maintains JSON side-indices for fast lookup.
 *
 * The markdown files are the source of truth. These indices are
 * derived caches that speed up common operations. They can be
 * rebuilt at any time from the .md files.
 *
 * Indices stored in: memory/_index/
 *   - metadata.json     (id -> {filepath, type, agent_id, ...})
 *   - tags.json         (tag -> [ids])
 *   - associations.json (id -> [related ids])
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  MemoryFrontmatter,
  TagIndex,
  AssociationIndex,
  MetadataIndex,
} from '../types/index.js';
import { atomicWrite, ensureDir } from '../utils/fs.js';

export class IndexManager {
  private metadata: MetadataIndex = {};
  private tags: TagIndex = {};
  private associations: AssociationIndex = {};
  private indexDir: string;

  constructor(memoryRoot: string) {
    this.indexDir = path.join(memoryRoot, '_index');
  }

  async load(): Promise<void> {
    await ensureDir(this.indexDir);
    this.metadata = await this.readJson('metadata.json', {});
    this.tags = await this.readJson('tags.json', {});
    this.associations = await this.readJson('associations.json', {});
  }

  getMetadata(id: string): MetadataIndex[string] | undefined {
    return this.metadata[id];
  }

  getIdsByTag(tag: string): string[] {
    return this.tags[tag] ?? [];
  }

  getAssociations(id: string): string[] {
    return this.associations[id] ?? [];
  }

  async add(fm: MemoryFrontmatter, filepath: string): Promise<void> {
    this.metadata[fm.id] = {
      filepath,
      type: fm.type,
      agent_id: fm.agent_id,
      importance: fm.importance,
      timestamp: fm.timestamp,
    };
    for (const tag of fm.tags) {
      this.tags[tag] = this.tags[tag] ?? [];
      if (!this.tags[tag].includes(fm.id)) this.tags[tag].push(fm.id);
    }
    if (fm.associations.length) {
      this.associations[fm.id] = fm.associations;
    }
    await this.persist();
  }

  async update(fm: MemoryFrontmatter, filepath: string): Promise<void> {
    await this.add(fm, filepath);
  }

  async remove(id: string): Promise<void> {
    delete this.metadata[id];
    for (const tag of Object.keys(this.tags)) {
      this.tags[tag] = this.tags[tag].filter((x) => x !== id);
      if (this.tags[tag].length === 0) delete this.tags[tag];
    }
    delete this.associations[id];
    // Remove from other memories' association lists
    for (const k of Object.keys(this.associations)) {
      this.associations[k] = this.associations[k].filter((x) => x !== id);
    }
    await this.persist();
  }

  async linkAssociation(a: string, b: string): Promise<void> {
    this.associations[a] = this.associations[a] ?? [];
    this.associations[b] = this.associations[b] ?? [];
    if (!this.associations[a].includes(b)) this.associations[a].push(b);
    if (!this.associations[b].includes(a)) this.associations[b].push(a);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await atomicWrite(
      path.join(this.indexDir, 'metadata.json'),
      JSON.stringify(this.metadata, null, 2)
    );
    await atomicWrite(
      path.join(this.indexDir, 'tags.json'),
      JSON.stringify(this.tags, null, 2)
    );
    await atomicWrite(
      path.join(this.indexDir, 'associations.json'),
      JSON.stringify(this.associations, null, 2)
    );
  }

  private async readJson<T>(filename: string, fallback: T): Promise<T> {
    try {
      const raw = await fs.readFile(path.join(this.indexDir, filename), 'utf8');
      return JSON.parse(raw) as T;
    } catch (err: any) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
    }
  }
}
