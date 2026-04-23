/**
 * NeuroMem — Type Definitions
 * Brain-inspired memory system for AI agents
 */

export type MemoryType =
  | "working" // Prefrontal Cortex — Redis
  | "episodic" // Hippocampus — Postgres
  | "semantic" // Temporal Cortex — ChromaDB
  | "procedural" // Cerebellum — ChromaDB + Postgres
  | "affective" // Amygdala — Postgres (tagged)
  | "shared"; // Cross-agent pool

export type EmotionalValence = "positive" | "negative" | "neutral";

/** Base memory shape returned by all stores */
export interface Memory {
  id: string;
  type: MemoryType;
  agent_id: string;
  title: string;
  content: string;
  timestamp: string;
  last_accessed: string | undefined;
  access_count: number;
  importance: number; // 0 – 1
  valence: EmotionalValence;
  arousal: number; // 0 – 1
  consolidation_level: number; // 0 – 1
  decay_rate: number;
  retention?: number; // 0 – 1, computed at recall time, never persisted
  tags: string[];
  source?: string;
  shared: boolean;
  associations?: string[];
  derived_from?: string[];
}

export interface WriteMemoryInput {
  content: string;
  agent_id: string;
  type?: MemoryType;
  title?: string;
  tags?: string[];
  importance?: number;
  valence?: EmotionalValence;
  arousal?: number;
  shared?: boolean;
  source?: string;
  /** Tool or harness that created this memory, e.g. "claude", "copilot", "gpt" */
  created_by?: string;
  /** Session identifier for grouping memories by conversation */
  session_id?: string;
  ttl_seconds?: number; // for working memory
  topic?: string;
}

export interface RecallQuery {
  query: string;
  agent_id: string;
  type?: MemoryType | MemoryType[];
  limit?: number;
  min_importance?: number;
  tags?: string[];
  include_shared?: boolean;
  time_range?: { from?: string; to?: string };
}

export interface RecallResult {
  memories: Memory[];
  strategy: "vector" | "keyword" | "temporal" | "graph" | "hybrid";
  scanned: number;
}

export interface ConsolidationReport {
  processed: number;
  consolidated: number;
  forgotten: number;
  new_semantic: number;
  new_skills: number;
  duration_ms: number;
}

export interface Skill {
  id: string;
  agent_id: string;
  name: string;
  description: string;
  steps: string[];
  success_count: number;
  failure_count: number;
  last_used: string | null;
  created_at: string;
  shared: boolean;
  tags: string[];
}
