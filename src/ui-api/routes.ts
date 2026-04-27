/**
 * UI API routes — /api/ui/*
 * UI-optimized endpoints for the memory inspection dashboard.
 * These are separate from /tools/* MCP endpoints.
 */

import { Router, type Request, type Response } from "express";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryManager } from "../stores/MemoryManager.js";
import type { Consolidator } from "../consolidation/Consolidator.js";
import {
  sumTokens,
  isTokenizerFallback,
  getActiveEncoding,
} from "../utils/tokens.js";
import type { BenchReport } from "../eval/types.js";

export function createUiRouter(
  mgr: MemoryManager,
  consolidator: Consolidator,
): Router {
  const router = Router();

  const ok = (res: Response, data: unknown) => res.json({ ok: true, data });
  const fail = (res: Response, status: number, message: string) =>
    res.status(status).json({ ok: false, error: message });

  // GET /api/ui/agents
  router.get("/agents", async (_req: Request, res: Response) => {
    try {
      const agents = await mgr.episodic.listAgents();
      ok(res, agents);
    } catch (e: unknown) {
      fail(res, 500, e instanceof Error ? e.message : String(e));
    }
  });

  // GET /api/ui/memories
  router.get("/memories", async (req: Request, res: Response) => {
    try {
      const {
        agent_id = "all",
        type,
        q,
        page = "1",
        limit = "20",
        min_importance,
      } = req.query as Record<string, string>;
      const pageNum = Math.max(1, parseInt(page, 10));
      const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
      const minImp =
        min_importance !== undefined ? parseFloat(min_importance) : undefined;

      // Resolve agent list — "all" fans out across every registered agent
      const agentIds =
        agent_id === "all" ? await mgr.episodic.listAgents() : [agent_id];

      let all: import("../types/index.js").Memory[];

      if (!q) {
        // Browse mode — no per-agent limit so global sort+paginate is accurate
        const perAgent = await Promise.all(
          agentIds.map((aid) =>
            mgr.listAll({
              agent_id: aid,
              type: (type as any) || undefined,
              min_importance: minImp,
            }),
          ),
        );
        all = perAgent
          .flat()
          .sort(
            (a, b) =>
              new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
          );
      } else {
        // Search mode — embedding-based recall
        const perAgent = await Promise.all(
          agentIds.map((aid) =>
            mgr
              .recall({
                query: q,
                agent_id: aid,
                type: (type as any) || undefined,
                limit: limitNum * pageNum,
                min_importance: minImp,
              })
              .then((r) => r.memories),
          ),
        );
        all = perAgent.flat().sort((a, b) => b.importance - a.importance);
      }

      const total = all.length;
      const memories = all.slice((pageNum - 1) * limitNum, pageNum * limitNum);

      ok(res, { memories, total, page: pageNum, limit: limitNum });
    } catch (e: unknown) {
      fail(res, 500, e instanceof Error ? e.message : String(e));
    }
  });

  // GET /api/ui/memories/:id
  router.get("/memories/:id", async (req: Request, res: Response) => {
    try {
      const memory = await mgr.readById(req.params.id);
      if (!memory) {
        fail(res, 404, "Memory not found");
        return;
      }
      ok(res, memory);
    } catch (e: unknown) {
      fail(res, 500, e instanceof Error ? e.message : String(e));
    }
  });

  // PUT /api/ui/memories/:id
  router.put("/memories/:id", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { importance, tags, title } = req.body as {
        importance?: number;
        tags?: string[];
        title?: string;
      };

      if (id.startsWith("epi_")) {
        await mgr.episodic.update(id, { importance, tags, title });
      } else {
        fail(
          res,
          400,
          "Cannot update this memory type via UI (only episodic memories supported)",
        );
        return;
      }

      const updated = await mgr.readById(id);
      ok(res, updated);
    } catch (e: unknown) {
      fail(res, 500, e instanceof Error ? e.message : String(e));
    }
  });

  // DELETE /api/ui/memories/:id
  router.delete("/memories/:id", async (req: Request, res: Response) => {
    try {
      const forgotten = await mgr.forget(req.params.id);
      ok(res, { forgotten });
    } catch (e: unknown) {
      fail(res, 500, e instanceof Error ? e.message : String(e));
    }
  });

  // GET /api/ui/memories/:id/history
  router.get("/memories/:id/history", async (req: Request, res: Response) => {
    try {
      const history = await mgr.getVersionHistory(req.params.id);
      ok(res, history);
    } catch (e: unknown) {
      fail(res, 500, e instanceof Error ? e.message : String(e));
    }
  });

  // POST /api/ui/memories — create a new memory via UI
  router.post("/memories", async (req: Request, res: Response) => {
    try {
      const result = await mgr.remember(req.body);
      ok(res, result);
    } catch (e: unknown) {
      fail(res, 500, e instanceof Error ? e.message : String(e));
    }
  });

  // GET /api/ui/spreading-activation/:id
  router.get(
    "/spreading-activation/:id",
    async (req: Request, res: Response) => {
      try {
        const hops = parseInt((req.query.hops as string) ?? "2", 10);
        const limit = parseInt((req.query.limit as string) ?? "20", 10);
        const memories = await mgr.spreadingActivation(
          req.params.id,
          hops,
          limit,
        );
        ok(res, memories);
      } catch (e: unknown) {
        fail(res, 500, e instanceof Error ? e.message : String(e));
      }
    },
  );

  // POST /api/ui/build-context
  router.post("/build-context", async (req: Request, res: Response) => {
    try {
      const {
        query,
        agent_id = "default",
        limit = 8,
      } = req.body as {
        query: string;
        agent_id?: string;
        limit?: number;
      };
      const result = await mgr.buildContext(query, agent_id, limit);
      ok(res, result);
    } catch (e: unknown) {
      fail(res, 500, e instanceof Error ? e.message : String(e));
    }
  });

  // GET /api/ui/memories/:id/history
  router.get("/memories/:id/history", async (req: Request, res: Response) => {
    try {
      const history = await mgr.getVersionHistory(req.params.id);
      ok(res, history);
    } catch (e: unknown) {
      fail(res, 500, e instanceof Error ? e.message : String(e));
    }
  });

  // POST /api/ui/memories — create a new memory via UI
  router.post("/memories", async (req: Request, res: Response) => {
    try {
      const result = await mgr.remember(req.body);
      ok(res, result);
    } catch (e: unknown) {
      fail(res, 500, e instanceof Error ? e.message : String(e));
    }
  });

  // GET /api/ui/spreading-activation/:id
  router.get(
    "/spreading-activation/:id",
    async (req: Request, res: Response) => {
      try {
        const hops = parseInt((req.query.hops as string) ?? "2", 10);
        const limit = parseInt((req.query.limit as string) ?? "20", 10);
        const memories = await mgr.spreadingActivation(
          req.params.id,
          hops,
          limit,
        );
        ok(res, memories);
      } catch (e: unknown) {
        fail(res, 500, e instanceof Error ? e.message : String(e));
      }
    },
  );

  // POST /api/ui/build-context
  router.post("/build-context", async (req: Request, res: Response) => {
    try {
      const {
        query,
        agent_id = "default",
        limit = 8,
      } = req.body as {
        query: string;
        agent_id?: string;
        limit?: number;
      };
      const result = await mgr.buildContext(query, agent_id, limit);
      ok(res, result);
    } catch (e: unknown) {
      fail(res, 500, e instanceof Error ? e.message : String(e));
    }
  });

  // GET /api/ui/graph/:agent_id
  router.get("/graph/:agent_id", async (req: Request, res: Response) => {
    try {
      const { agent_id } = req.params;
      const { nodes: rawNodes, edges: rawEdges } =
        await mgr.associations.listNodesAndEdges(agent_id);

      const nodes = await Promise.all(
        rawNodes.map(async (n) => {
          const mem = await mgr.readById(n.id);
          return {
            id: n.id,
            label: mem ? (mem.title ?? "") || mem.content.slice(0, 60) : n.id,
            type: n.type,
            importance: mem?.importance ?? 0.5,
            content: mem?.content.slice(0, 120) ?? "",
            tags: mem?.tags ?? [],
          };
        }),
      );

      ok(res, { nodes, links: rawEdges });
    } catch (e: unknown) {
      fail(res, 500, e instanceof Error ? e.message : String(e));
    }
  });

  // GET /api/ui/reflect/:agent_id
  router.get("/reflect/:agent_id", async (req: Request, res: Response) => {
    try {
      const result = await mgr.reflect(req.params.agent_id);
      ok(res, result);
    } catch (e: unknown) {
      fail(res, 500, e instanceof Error ? e.message : String(e));
    }
  });

  // POST /api/ui/consolidate/:agent_id
  router.post("/consolidate/:agent_id", async (req: Request, res: Response) => {
    try {
      const result = await consolidator.run(req.params.agent_id);
      ok(res, result);
    } catch (e: unknown) {
      fail(res, 500, e instanceof Error ? e.message : String(e));
    }
  });

  // GET /api/ui/stats
  // Summary numbers for the MemoryBrowser stats strip:
  //   - memory_count:    total memories across every agent
  //   - tokens_stored:   tiktoken count of all memory content
  //   - latest_bench:    headline token-savings from the most recent
  //                      .bench/*.json run (null if none exist yet)
  router.get("/stats", async (_req: Request, res: Response) => {
    try {
      const agents = await mgr.episodic.listAgents();
      const perAgent = await Promise.all(
        agents.map((aid) => mgr.listAll({ agent_id: aid })),
      );
      const all = perAgent.flat();
      const tokens_stored = sumTokens(all.map((m) => m.content));

      // Live savings pulled from the recall_stats table — cumulative, 24h,
      // and 7d rollups. null-safe: fresh installs with zero recalls get a
      // zero-count aggregate, which the UI renders as a "no recalls yet" hint.
      const now = Date.now();
      const [totals, window_24h, window_7d] = await Promise.all([
        mgr.recallStats.getTotals(),
        mgr.recallStats.getWindow(
          new Date(now - 24 * 60 * 60 * 1000).toISOString(),
        ),
        mgr.recallStats.getWindow(
          new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
        ),
      ]);

      ok(res, {
        memory_count: all.length,
        tokens_stored,
        tokens_estimated: isTokenizerFallback(),
        tokens_encoding: getActiveEncoding(),
        latest_bench: readLatestBench(),
        live_savings: {
          totals,
          window_24h,
          window_7d,
        },
      });
    } catch (e: unknown) {
      fail(res, 500, e instanceof Error ? e.message : String(e));
    }
  });

  // GET /api/ui/cognition-log
  router.get("/cognition-log", async (_req: Request, res: Response) => {
    try {
      const result = await mgr.recall({
        query: "cognition cycle background",
        agent_id: "system",
        type: "working",
        limit: 50,
      });
      const entries = result.memories.map((m) => ({
        id: m.id,
        content: m.content,
        timestamp: m.timestamp,
      }));
      ok(res, entries);
    } catch (e: unknown) {
      fail(res, 500, e instanceof Error ? e.message : String(e));
    }
  });

  return router;
}

/**
 * Scan the .bench/ directory for the newest JSON report that contains a
 * `tokens` summary block and return the headline savings numbers. Returns
 * null if the directory is missing, empty, or contains only old reports
 * without token accounting.
 *
 * We read lazily on each /stats request — benchmarks aren't fired often and
 * the reports are small, so caching adds complexity for little win.
 */
function readLatestBench(): {
  timestamp: string;
  run_id: string;
  dataset: string;
  query_count: number;
  baseline_total: number;
  neuromem_total: number;
  saved_total: number;
  reduction_pct: number;
  baseline_mean: number;
  neuromem_mean: number;
  saved_mean: number;
  encoding: string;
  estimated: boolean;
} | null {
  const benchDir = join(process.cwd(), ".bench");
  if (!existsSync(benchDir)) return null;

  const files = readdirSync(benchDir)
    .filter((f) => f.endsWith(".json"))
    // Sort by filename descending — our filenames are ISO timestamps so
    // lexicographic ordering matches chronological ordering.
    .sort((a, b) => b.localeCompare(a));

  for (const file of files) {
    try {
      const raw = readFileSync(join(benchDir, file), "utf-8");
      const report = JSON.parse(raw) as BenchReport;
      if (!report.summary?.tokens) continue; // old report, skip
      const t = report.summary.tokens;
      return {
        timestamp: report.timestamp,
        run_id: report.run_id,
        dataset: report.config.dataset_name,
        query_count: report.config.query_count,
        baseline_total: t.baseline_total,
        neuromem_total: t.neuromem_total,
        saved_total: t.saved_total,
        reduction_pct: t.reduction_pct,
        baseline_mean: t.baseline_mean,
        neuromem_mean: t.neuromem_mean,
        saved_mean: t.saved_mean,
        encoding: t.encoding,
        estimated: t.estimated,
      };
    } catch {
      // Corrupt or partial file — skip and try the next newest.
      continue;
    }
  }
  return null;
}
