/**
 * Filesystem utilities for the memory store
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MemoryType } from '../types/index.js';

/** Root directory for all memories (configurable via env) */
export const MEMORY_ROOT =
  process.env.NEUROMEM_ROOT ?? path.resolve(process.cwd(), 'memory');

/** Convert a string into a safe filename slug */
export function slugify(text: string, maxLen = 60): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, maxLen) || 'memory';
}

/** YYYY-MM-DD from ISO timestamp */
export function dateFolder(iso: string): string {
  return iso.slice(0, 10);
}

/** Compute storage path for a memory based on type + metadata */
export function memoryPath(params: {
  type: MemoryType;
  agent_id: string;
  timestamp: string;
  title: string;
  topic?: string;
  id: string;
}): string {
  const { type, agent_id, timestamp, title, topic, id } = params;
  const slug = slugify(title);
  const filename = `${timestamp.slice(0, 19).replace(/[:.]/g, '-')}__${slug}__${id}.md`;

  switch (type) {
    case 'episodic':
      return path.join(MEMORY_ROOT, 'episodic', agent_id, dateFolder(timestamp), filename);
    case 'semantic':
      return path.join(MEMORY_ROOT, 'semantic', agent_id, topic ?? 'general', filename);
    case 'procedural':
      return path.join(MEMORY_ROOT, 'procedural', agent_id, filename);
    case 'affective':
      return path.join(MEMORY_ROOT, 'affective', agent_id, filename);
    case 'working':
      return path.join(MEMORY_ROOT, 'working', agent_id, filename);
    case 'shared':
      return path.join(MEMORY_ROOT, 'shared', filename);
  }
}

/** Ensure a directory exists (recursive) */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Atomically write a file (write to temp, then rename) */
export async function atomicWrite(filepath: string, contents: string): Promise<void> {
  await ensureDir(path.dirname(filepath));
  const tmp = `${filepath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, contents, 'utf8');
  await fs.rename(tmp, filepath);
}

/** Recursively list all .md files in a directory */
export async function listMarkdownFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await listMarkdownFiles(full)));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
  return results;
}

/** Get the base directory for a given memory type */
export function typeDir(type: MemoryType, agent_id?: string): string {
  if (type === 'shared') return path.join(MEMORY_ROOT, 'shared');
  if (!agent_id) return path.join(MEMORY_ROOT, type);
  return path.join(MEMORY_ROOT, type, agent_id);
}
