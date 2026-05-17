/**
 * ProxyServer — OpenAI-compatible LLM proxy with automatic memory injection
 *
 * Mounts a POST /v1/chat/completions endpoint on an existing Express app.
 * Agents only need to change their baseURL — no other code changes required.
 *
 * Per-request flow:
 *   1. Parse incoming OpenAI chat request
 *   2. Recall relevant memories → inject <memory> block into system prompt
 *   3. Forward augmented request to real LLM API
 *   4. Stream/return response to caller with observability headers
 *   5. Fire extractAndStore() in background (non-blocking)
 */

import type { Express, Request, Response } from "express";
import type { MemoryManager } from "../stores/MemoryManager.js";
import type { InnerThought } from "../cognition/InnerThought.js";
import { extractAndStore } from "../cognition/Extractor.js";
import { nanoid } from "nanoid";

// ─── Config ───────────────────────────────────────────────────────

export interface ProxyConfig {
  /** URL of the upstream LLM API (e.g. https://api.openai.com) */
  targetUrl: string;
  /** "openai" | "anthropic" — selects SSE parsing strategy */
  targetProvider: "openai" | "anthropic";
  /** Fraction of the model's max_tokens budget to spend on memories (0.05–0.40) */
  memoryBudgetPct: number;
}

// ─── OpenAI message types ─────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
}

interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  [key: string]: unknown;
}

// ─── Memory injection ─────────────────────────────────────────────

async function injectMemories(
  messages: ChatMessage[],
  query: string,
  agentId: string,
  model: string | undefined,
  memoryBudgetPct: number,
  mgr: MemoryManager,
  projectRoot: string | undefined,
): Promise<{ messages: ChatMessage[]; injected: number; tokensUsed: number; staleFiles: string[] }> {
  // Estimate a reasonable budget: 2048 tokens unless max_tokens is known
  const contextBudget = Math.floor(2048 * Math.min(Math.max(memoryBudgetPct, 0.05), 0.40));

  let result;
  try {
    result = await mgr.buildContext(query, agentId, {
      limit: 10,
      context_budget: contextBudget,
      model,
      project_root: projectRoot,
    });
  } catch (err) {
    console.warn("[Proxy] buildContext failed — proceeding without memory injection:", err);
    return { messages, injected: 0, tokensUsed: 0, staleFiles: [] };
  }

  const staleFiles = result.metadata.stale_files ?? [];

  if (!result.context || result.metadata.injected_count === 0) {
    return { messages, injected: 0, tokensUsed: 0, staleFiles };
  }

  const memoryBlock = `\nYou have access to the following memory context from previous interactions:\n${result.context}\n`;

  // Splice into existing system message or prepend a new one
  const augmented = [...messages];
  const sysIdx = augmented.findIndex((m) => m.role === "system");

  if (sysIdx >= 0) {
    augmented[sysIdx] = {
      ...augmented[sysIdx],
      content: (augmented[sysIdx].content ?? "") + memoryBlock,
    };
  } else {
    augmented.unshift({ role: "system", content: memoryBlock.trim() });
  }

  return {
    messages: augmented,
    injected: result.metadata.injected_count,
    tokensUsed: result.metadata.tokens_used,
    staleFiles,
  };
}

// ─── SSE reconstruction (for extraction after stream ends) ────────

function reconstructAssistantMessage(
  chunks: string[],
  provider: "openai" | "anthropic",
): string {
  let text = "";

  for (const chunk of chunks) {
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);

        if (provider === "openai") {
          // OpenAI: {"choices":[{"delta":{"content":"..."}}]}
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === "string") text += delta;
        } else {
          // Anthropic: {"type":"content_block_delta","delta":{"text":"..."}}
          const deltaText = parsed?.delta?.text;
          if (typeof deltaText === "string") text += deltaText;
        }
      } catch {
        // Malformed chunk — skip
      }
    }
  }

  return text;
}

// ─── Mount function ───────────────────────────────────────────────

export function mountProxy(
  app: Express,
  mgr: MemoryManager,
  innerThought: InnerThought | undefined,
  proxyConfig: ProxyConfig,
): void {
  const { targetUrl, targetProvider, memoryBudgetPct } = proxyConfig;
  const baseUrl = targetUrl.replace(/\/$/, "");

  console.log(
    `[Proxy] Mounted at /v1/chat/completions → ${baseUrl} (provider: ${targetProvider})`,
  );

  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
    const agentId =
      (req.headers["x-neuromem-agent-id"] as string | undefined) ?? "default";
    const sessionId =
      (req.headers["x-neuromem-session-id"] as string | undefined) ?? nanoid();
    const projectRoot =
      (req.headers["x-neuromem-project-root"] as string | undefined) ?? undefined;

    const body = req.body as ChatRequest;
    const isStream = body.stream === true;

    // ── Extract recall query from last user message ────────────────
    const lastUserMsg = [...(body.messages ?? [])]
      .reverse()
      .find((m) => m.role === "user");
    const query =
      typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";

    // ── Inject memories ───────────────────────────────────────────
    const { messages: augmentedMessages, injected, tokensUsed, staleFiles } =
      await injectMemories(
        body.messages ?? [],
        query,
        agentId,
        body.model,
        memoryBudgetPct,
        mgr,
        projectRoot,
      );

    // ── Build forwarded request ───────────────────────────────────
    const forwardBody: ChatRequest = { ...body, messages: augmentedMessages };
    const forwardHeaders: Record<string, string> = {
      "content-type": "application/json",
    };

    // Passthrough Authorization header — NeuroMem never reads the key
    if (req.headers["authorization"]) {
      forwardHeaders["authorization"] = req.headers["authorization"] as string;
    }
    if (req.headers["x-api-key"]) {
      forwardHeaders["x-api-key"] = req.headers["x-api-key"] as string;
    }
    if (req.headers["anthropic-version"]) {
      forwardHeaders["anthropic-version"] = req.headers["anthropic-version"] as string;
    }

    // ── Observability headers ─────────────────────────────────────
    res.setHeader("x-neuromem-memories-injected", String(injected));
    res.setHeader("x-neuromem-tokens-used", String(tokensUsed));
    res.setHeader("x-neuromem-session-id", sessionId);
    // Signal which files need re-analysis (empty string = all fresh)
    if (staleFiles.length > 0) {
      res.setHeader("x-neuromem-stale-files", staleFiles.join(","));
    }

    // ── Forward to LLM ────────────────────────────────────────────
    let upstreamRes: globalThis.Response;
    try {
      upstreamRes = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: forwardHeaders,
        body: JSON.stringify(forwardBody),
      });
    } catch (err) {
      console.error("[Proxy] Failed to reach upstream LLM:", err);
      res.status(502).json({ error: "Upstream LLM unreachable", detail: String(err) });
      return;
    }

    // ── Error passthrough ─────────────────────────────────────────
    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      res.status(upstreamRes.status).send(errText);
      return;
    }

    // ── Streaming response ────────────────────────────────────────
    if (isStream && upstreamRes.body) {
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");

      const chunks: string[] = [];
      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          chunks.push(text);
          res.write(text);
        }
      } finally {
        res.end();
        reader.releaseLock();
      }

      // Fire extraction in background — never block the response
      setImmediate(() => {
        const assistantText = reconstructAssistantMessage(chunks, targetProvider);
        if (assistantText && query) {
          extractAndStore(agentId, query, assistantText, mgr, innerThought, sessionId, projectRoot).catch(
            () => {},
          );
        }
      });

      return;
    }

    // ── Non-streaming response ────────────────────────────────────
    const responseText = await upstreamRes.text();
    res.setHeader("content-type", "application/json");
    res.status(upstreamRes.status).send(responseText);

    // Fire extraction in background
    setImmediate(() => {
      try {
        const parsed = JSON.parse(responseText);
        const assistantText: string =
          parsed?.choices?.[0]?.message?.content ?? // OpenAI
          parsed?.content?.[0]?.text ?? // Anthropic
          "";

        if (assistantText && query) {
          extractAndStore(agentId, query, assistantText, mgr, innerThought, sessionId, projectRoot).catch(
            () => {},
          );
        }
      } catch {
        // Unparseable response — skip extraction
      }
    });
  });
}
