import { apiFetch } from "./client";
import type { ReflectStats } from "../types";

export function getAgents(): Promise<string[]> {
  return apiFetch<string[]>("/agents");
}

export function getReflect(agent_id: string): Promise<ReflectStats> {
  return apiFetch<ReflectStats>(`/reflect/${agent_id}`);
}

export function runConsolidate(agent_id: string): Promise<unknown> {
  return apiFetch(`/consolidate/${agent_id}`, { method: "POST" });
}
