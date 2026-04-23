export type MemoryType =
  | "working"
  | "episodic"
  | "semantic"
  | "procedural"
  | "affective"
  | "shared";
export type EmotionalValence = "positive" | "negative" | "neutral";

export interface Memory {
  id: string;
  agent_id: string;
  type: MemoryType;
  content: string;
  title?: string;
  tags: string[];
  importance: number;
  valence: EmotionalValence;
  arousal: number;
  timestamp: string;
  access_count: number;
  consolidation_level: number;
  decay_rate?: number;
  last_accessed?: string;
  conflicting_ids?: string[];
}

export interface MemoryListResponse {
  memories: Memory[];
  total: number;
  page: number;
  limit: number;
}

export interface GraphNode {
  id: string;
  label: string;
  type: MemoryType;
  importance: number;
  content: string;
  tags: string[];
}

export interface VersionEntry {
  version: number;
  content: string;
  title: string;
  importance: number;
  tags: string[];
  archived_at: string;
  reason: string | null;
}

export interface GraphLink {
  source: string;
  target: string;
  label?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface ReflectStats {
  timeframe_days: number;
  counts: {
    working: number;
    episodic: number;
    semantic: number;
    procedural: number;
  };
  graph: {
    nodes: number;
    edges: number;
  };
}

export interface CognitionEntry {
  id: string;
  content: string;
  timestamp: string;
}
