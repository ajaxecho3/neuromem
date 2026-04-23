const BASE = "/api/ui";

export class ApiError extends Error {
  constructor(_status: number, message: string) {
    super(message);
  }
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) {
    throw new ApiError(res.status, json.error ?? `HTTP ${res.status}`);
  }
  return (json.data ?? json) as T;
}
