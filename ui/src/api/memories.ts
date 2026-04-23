import { apiFetch } from "./client";
import type { Memory, MemoryListResponse, VersionEntry } from "../types";

export interface MemoryFilters {
  agent_id?: string;
  type?: string;
  q?: string;
  page?: number;
  limit?: number;
  min_importance?: number;
  tags?: string;
}

export function getMemories(
  filters: MemoryFilters = {},
): Promise<MemoryListResponse> {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== "") params.set(k, String(v));
  });
  return apiFetch<MemoryListResponse>(`/memories?${params}`);
}

export function getMemory(id: string): Promise<Memory> {
  return apiFetch<Memory>(`/memories/${id}`);
}

export function updateMemory(
  id: string,
  patch: Partial<Pick<Memory, "importance" | "tags" | "title">>,
): Promise<Memory> {
  return apiFetch<Memory>(`/memories/${id}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export function deleteMemory(id: string): Promise<void> {
  return apiFetch<void>(`/memories/${id}`, { method: "DELETE" });
}

export function createMemory(input: {
  content: string;
  agent_id?: string;
  type?: string;
  title?: string;
  tags?: string[];
  importance?: number;
}): Promise<Memory> {
  return apiFetch<Memory>(`/memories`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getVersionHistory(id: string): Promise<VersionEntry[]> {
  return apiFetch<VersionEntry[]>(`/memories/${id}/history`);
}
