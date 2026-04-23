import { apiFetch } from "./client";
import type { CognitionEntry } from "../types";

export function getCognitionLog(): Promise<CognitionEntry[]> {
  return apiFetch<CognitionEntry[]>("/cognition-log");
}
