import { apiFetch } from "./client";
import type { GraphData, Memory } from "../types";

export function getGraph(agent_id: string): Promise<GraphData> {
  return apiFetch<GraphData>(`/graph/${agent_id}`);
}

export function getSpreadingActivation(
  id: string,
  hops = 2,
): Promise<Memory[]> {
  return apiFetch<Memory[]>(`/spreading-activation/${id}?hops=${hops}`);
}

export function buildContext(
  query: string,
  agent_id: string,
  limit = 8,
): Promise<{ context: string; memories: Memory[]; token_estimate: number }> {
  return apiFetch(`/build-context`, {
    method: "POST",
    body: JSON.stringify({ query, agent_id, limit }),
  });
}
