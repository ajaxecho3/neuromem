/**
 * Centralized environment config loader
 */

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const config = {
  server: {
    mode: (process.env.SERVER_MODE ?? "http") as "http" | "stdio",
    port: parseInt(process.env.HTTP_PORT ?? "3000", 10),
  },
  postgres: {
    host: req("POSTGRES_HOST", "localhost"),
    port: parseInt(req("POSTGRES_PORT", "5432"), 10),
    database: req("POSTGRES_DB", "neuromem"),
    user: req("POSTGRES_USER", "neuromem"),
    password: req("POSTGRES_PASSWORD", "changeme"),
  },
  chroma: {
    host: req("CHROMA_HOST", "localhost"),
    port: parseInt(req("CHROMA_PORT", "8000"), 10),
    token: req("CHROMA_TOKEN", "neuromem-secret"),
  },
  neo4j: {
    uri: req("NEO4J_URI", "bolt://localhost:7687"),
    user: req("NEO4J_USER", "neo4j"),
    password: req("NEO4J_PASSWORD", "neuromem-pass"),
  },
  redis: {
    host: req("REDIS_HOST", "localhost"),
    port: parseInt(req("REDIS_PORT", "6379"), 10),
    password: process.env.REDIS_PASSWORD,
  },
  embeddings: {
    provider: (process.env.EMBEDDING_PROVIDER ?? "local") as
      | "local"
      | "openai"
      | "voyage",
    openaiKey: process.env.OPENAI_API_KEY,
    voyageKey: process.env.VOYAGE_API_KEY,
  },
  llm: {
    anthropicKey: process.env.ANTHROPIC_API_KEY,
  },
  cognition: {
    /** LLM backend: ollama | openai | anthropic | none */
    provider: (process.env.LLM_PROVIDER ?? "ollama") as
      | "ollama"
      | "openai"
      | "anthropic"
      | "none",
    ollamaUrl: req("OLLAMA_URL", "http://localhost:11434"),
    model: req("INNER_THOUGHT_MODEL", "gemma4"),
    openaiKey: process.env.OPENAI_API_KEY,
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    timeoutMs: parseInt(process.env.INNER_THOUGHT_TIMEOUT_MS ?? "2000", 10),
    backgroundEnabled: (process.env.COGNITION_ENABLED ?? "true") === "true",
    intervalMinutes: parseInt(
      process.env.COGNITION_INTERVAL_MINUTES ?? "30",
      10,
    ),
    retentionScaleDays: parseInt(process.env.RETENTION_SCALE_DAYS ?? "30", 10),
  },
  proxy: {
    /** Set PROXY_ENABLED=true to activate the drop-in LLM proxy */
    enabled: (process.env.PROXY_ENABLED ?? "false") === "true",
    /** Port to expose the proxy on (separate from the MCP/REST port) */
    port: parseInt(process.env.PROXY_PORT ?? "3001", 10),
    /** Full base URL of the upstream LLM API, e.g. https://api.openai.com */
    targetUrl: process.env.PROXY_TARGET_URL ?? "",
    /** openai | anthropic — affects SSE parsing strategy */
    targetProvider: (process.env.PROXY_TARGET_PROVIDER ?? "openai") as
      | "openai"
      | "anthropic",
    /** Fraction of context window allocated to memory injection (clamped 0.05–0.40) */
    memoryBudgetPct: Math.min(
      0.40,
      Math.max(0.05, parseFloat(process.env.PROXY_MEMORY_BUDGET_PCT ?? "0.20")),
    ),
  },
};
