#!/usr/bin/env node
/**
 * NeuroMem Server
 *
 * Supports two modes (set via SERVER_MODE env var):
 *   - 'stdio' — pure MCP server via stdio (for Claude Desktop, etc.)
 *   - 'http'  — HTTP REST API + MCP-over-SSE (for containerized deployment)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { MemoryManager } from "../stores/MemoryManager.js";
import { Consolidator } from "../consolidation/Consolidator.js";
import { config } from "../utils/config.js";
import { InnerThought } from "../cognition/InnerThought.js";
import { BackgroundCognition } from "../cognition/BackgroundCognition.js";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createUiRouter } from "../ui-api/routes.js";
import { parseTimeExpression } from "../utils/timeParser.js";

// ─── Zod schemas ───────────────────────────────────────────────

const MEM_TYPES = [
  "working",
  "episodic",
  "semantic",
  "procedural",
  "affective",
  "shared",
] as const;

const RememberSchema = z.object({
  content: z.string(),
  agent_id: z.string().default("default"),
  type: z.enum(MEM_TYPES).optional(),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional(),
  topic: z.string().optional(),
  ttl_seconds: z.number().optional(),
  shared: z.boolean().optional(),
  created_by: z.string().optional(),
  session_id: z.string().optional(),
});

const RecallSchema = z.object({
  query: z.string(),
  agent_id: z.string().default("default"),
  type: z.union([z.enum(MEM_TYPES), z.array(z.enum(MEM_TYPES))]).optional(),
  limit: z.number().default(5),
  min_importance: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  include_shared: z.boolean().default(true),
  time_range: z
    .object({ from: z.string().optional(), to: z.string().optional() })
    .optional(),
  time_query: z.string().optional(),
});

const AssociateSchema = z.object({ id_a: z.string(), id_b: z.string() });
const SpreadSchema = z.object({
  id: z.string(),
  hops: z.number().default(2),
  limit: z.number().default(20),
});
const ForgetObjectSchema = z.object({
  id: z.string().optional(),
  query: z.string().optional(),
  agent_id: z.string().default("default"),
  type: z.union([z.enum(MEM_TYPES), z.array(z.enum(MEM_TYPES))]).optional(),
  limit: z.number().default(50),
});
const ForgetSchema = ForgetObjectSchema.refine((d) => d.id || d.query, {
  message: "Either id or query is required",
});
const ConsolidateSchema = z.object({ agent_id: z.string().default("default") });
const ReflectSchema = z.object({
  agent_id: z.string().default("default"),
  timeframe_days: z.number().default(7),
});
const BuildContextSchema = z.object({
  query: z.string(),
  agent_id: z.string().default("default"),
  limit: z.number().default(8),
});
const RememberBatchSchema = z.object({
  memories: z.array(RememberSchema).min(1).max(20),
});
const MemoryHistorySchema = z.object({ id: z.string() });

// ─── Build MCP server ──────────────────────────────────────────

function buildMcpServer(
  mgr: MemoryManager,
  consolidator: Consolidator,
): McpServer {
  const server = new McpServer(
    { name: "neuromem", version: "0.1.0" },
    { capabilities: {} },
  );

  server.registerTool(
    "remember",
    {
      description:
        "Store a memory. Auto-routes to the right brain region (Redis/Postgres/ChromaDB) based on content. " +
        "Use for: user preferences, facts, completed events, learned procedures, emotionally significant moments.",
      inputSchema: RememberSchema.shape,
    },
    async (input) => {
      try {
        const result = await mgr.remember(input);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err.message ?? String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "recall",
    {
      description:
        "Hybrid search across all memory systems. Combines vector similarity (semantic/procedural), " +
        "keyword + timeline (episodic), and fast lookup (working). Ranked by importance × recency.",
      inputSchema: RecallSchema.shape,
    },
    async (input) => {
      try {
        let resolvedTimeRange = input.time_range;
        if (input.time_query && !resolvedTimeRange) {
          const parsed = await parseTimeExpression(
            input.time_query,
            new Date(),
            mgr.innerThought,
          );
          if (parsed) resolvedTimeRange = parsed;
        }
        const result = await mgr.recall({
          ...input,
          time_range: resolvedTimeRange,
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err.message ?? String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "associate",
    {
      description:
        "Link two memories in the association graph (Neo4j). Enables spreading-activation recall.",
      inputSchema: AssociateSchema.shape,
    },
    async ({ id_a, id_b }) => {
      try {
        await mgr.associate(id_a, id_b);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ linked: [id_a, id_b] }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err.message ?? String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "spreading_activation",
    {
      description:
        "Find memories within N graph hops of a given memory. Simulates cognitive priming.",
      inputSchema: SpreadSchema.shape,
    },
    async ({ id, hops, limit }) => {
      try {
        const memories = await mgr.spreadingActivation(id, hops, limit);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ memories }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err.message ?? String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "forget",
    {
      description:
        "Permanently delete a memory. Pass 'id' to delete by ID, or 'query' to delete all memories matching a natural-language query.",
      inputSchema: ForgetObjectSchema.shape,
    },
    async ({
      id,
      query,
      agent_id,
      type,
      limit,
    }: z.infer<typeof ForgetObjectSchema>) => {
      try {
        let result: unknown;
        if (id) {
          result = { forgotten: await mgr.forget(id) };
        } else {
          result = await mgr.forget({ query: query!, agent_id, type, limit });
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err.message ?? String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "consolidate",
    {
      description:
        "Run the sleep-inspired consolidation pass: cluster episodic memories, abstract to semantic, " +
        "forget stale low-importance entries.",
      inputSchema: ConsolidateSchema.shape,
    },
    async ({ agent_id }) => {
      try {
        const result = await consolidator.run(agent_id);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err.message ?? String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "reflect",
    {
      description:
        "Get counts + graph stats for an agent. Useful for meta-questions about memory state.",
      inputSchema: ReflectSchema.shape,
    },
    async ({ agent_id, timeframe_days }) => {
      try {
        const result = await mgr.reflect(agent_id, timeframe_days);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err.message ?? String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "build_context",
    {
      description:
        "Build a compact, ready-to-inject memory context string for LLM prompts. " +
        "Recalls top-N relevant memories and formats them as a numbered list. " +
        "Use this INSTEAD of passing full conversation history to reduce token consumption.",
      inputSchema: BuildContextSchema.shape,
    },
    async ({ query, agent_id, limit }) => {
      try {
        const result = await mgr.buildContext(query, agent_id, limit);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err.message ?? String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "remember_batch",
    {
      description:
        "Store multiple memories in a single call. Reduces round-trips when saving " +
        "several facts at end of session. Returns count of stored vs duplicates.",
      inputSchema: RememberBatchSchema.shape,
    },
    async ({ memories }) => {
      try {
        const result = await mgr.rememberBatch(memories);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err.message ?? String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "memory_history",
    {
      description:
        "Get the version history of an episodic memory — all previous versions before updates. " +
        "Only works for episodic memories (ids starting with epi_).",
      inputSchema: MemoryHistorySchema.shape,
    },
    async ({ id }) => {
      try {
        const history = await mgr.getVersionHistory(id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ id, history }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err.message ?? String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

// ─── Tool dispatch (shared between MCP + HTTP) ────────────────

async function dispatch(
  name: string,
  args: unknown,
  mgr: MemoryManager,
  consolidator: Consolidator,
): Promise<unknown> {
  switch (name) {
    case "remember": {
      const input = RememberSchema.parse(args);
      return mgr.remember(input);
    }
    case "recall": {
      const input = RecallSchema.parse(args);
      let resolvedTimeRange = input.time_range;
      if (input.time_query && !resolvedTimeRange) {
        const parsed = await parseTimeExpression(
          input.time_query,
          new Date(),
          mgr.innerThought,
        );
        if (parsed) resolvedTimeRange = parsed;
      }
      return mgr.recall({ ...input, time_range: resolvedTimeRange });
    }
    case "associate": {
      const input = AssociateSchema.parse(args);
      await mgr.associate(input.id_a, input.id_b);
      return { linked: [input.id_a, input.id_b] };
    }
    case "spreading_activation": {
      const input = SpreadSchema.parse(args);
      return {
        memories: await mgr.spreadingActivation(
          input.id,
          input.hops,
          input.limit,
        ),
      };
    }
    case "forget": {
      const input = ForgetSchema.parse(args);
      if (input.id) {
        return { forgotten: await mgr.forget(input.id) };
      }
      return mgr.forget({
        query: input.query!,
        agent_id: input.agent_id,
        type: input.type,
        limit: input.limit,
      });
    }
    case "consolidate": {
      const input = ConsolidateSchema.parse(args);
      return consolidator.run(input.agent_id);
    }
    case "reflect": {
      const input = ReflectSchema.parse(args);
      return mgr.reflect(input.agent_id, input.timeframe_days);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── HTTP mode ─────────────────────────────────────────────────

async function startHttp(mgr: MemoryManager, consolidator: Consolidator) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // Health
  app.get("/health", async (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // UI API routes
  app.use("/api/ui", createUiRouter(mgr, consolidator));

  // REST endpoints — one per tool
  const toolNames = [
    "remember",
    "recall",
    "associate",
    "spreading_activation",
    "forget",
    "consolidate",
    "reflect",
  ];
  for (const name of toolNames) {
    app.post(`/tools/${name}`, async (req: Request, res: Response) => {
      try {
        const result = await dispatch(name, req.body, mgr, consolidator);
        res.json({ ok: true, result });
      } catch (err: any) {
        res.status(400).json({ ok: false, error: err.message ?? String(err) });
      }
    });
  }

  // MCP Streamable HTTP transport (VS Code "type": "http" and modern clients)
  const streamableTransports = new Map<string, StreamableHTTPServerTransport>();
  const handleStreamable = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && streamableTransports.has(sessionId)) {
      await streamableTransports
        .get(sessionId)!
        .handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          streamableTransports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId)
          streamableTransports.delete(transport.sessionId);
      };
      const server = buildMcpServer(mgr, consolidator);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided",
      },
      id: null,
    });
  };
  app.get("/mcp", handleStreamable);
  app.post("/mcp", handleStreamable);
  app.delete("/mcp", handleStreamable);

  // Serve React SPA (production build)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const uiDist = join(__dirname, "..", "ui");
  app.use(express.static(uiDist));
  app.get("*", (_req: Request, res: Response) => {
    res.sendFile(join(uiDist, "index.html"));
  });

  app.listen(config.server.port, () => {
    console.log(`[neuromem] HTTP server on :${config.server.port}`);
    console.log(`[neuromem] REST endpoints under /tools/*`);
    console.log(`[neuromem] MCP Streamable HTTP at /mcp`);
  });
}

// ─── Stdio mode ────────────────────────────────────────────────

async function startStdio(mgr: MemoryManager, consolidator: Consolidator) {
  const server = buildMcpServer(mgr, consolidator);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[neuromem] MCP stdio server running");
}

// ─── Boot ──────────────────────────────────────────────────────

async function main() {
  console.log("[neuromem] booting...");
  const innerThought = new InnerThought();
  const mgr = await MemoryManager.create(innerThought);
  const consolidator = new Consolidator(mgr, { innerThought });
  const bgCognition = new BackgroundCognition(mgr, consolidator, innerThought);
  bgCognition.start();
  console.log("[neuromem] all stores connected");

  if (config.server.mode === "stdio") {
    await startStdio(mgr, consolidator);
  } else {
    await startHttp(mgr, consolidator);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[neuromem] ${signal} received — shutting down...`);
    bgCognition.stop();
    await mgr.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[neuromem] fatal:", err);
  process.exit(1);
});
