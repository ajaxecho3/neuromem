/**
 * BackgroundCognition — the "sleep cycle" of NeuroMem
 *
 * Runs periodically and autonomously manages memory health:
 * - Reflects on current memory state per agent
 * - Identifies stale/low-importance candidates
 * - Asks InnerThought to decide: forget, consolidate, promote, or keep
 * - Executes decided actions via MemoryManager
 * - Logs a brief cognition summary to working memory (1h TTL)
 */

import { config } from "../utils/config.js";
import type { MemoryManager } from "../stores/MemoryManager.js";
import type { Consolidator } from "../consolidation/Consolidator.js";
import type { InnerThought } from "./InnerThought.js";

type CognitionAction = "forget" | "consolidate" | "promote" | "keep";

interface CognitionDecision {
  id: string;
  action: CognitionAction;
}

export class BackgroundCognition {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private mgr: MemoryManager,
    private consolidator: Consolidator,
    private innerThought: InnerThought,
  ) {}

  start(): void {
    if (!config.cognition.backgroundEnabled) return;

    const intervalMs = config.cognition.intervalMinutes * 60 * 1000;
    this.timer = setInterval(() => {
      this.runSafely().catch((err) =>
        console.error("[BackgroundCognition] unhandled error:", err),
      );
    }, intervalMs);

    console.log(
      `[BackgroundCognition] started — interval: ${config.cognition.intervalMinutes}m, model: ${config.cognition.model}`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[BackgroundCognition] stopped");
    }
  }

  /** Public for manual triggering (e.g. via MCP tool in the future) */
  async runSafely(): Promise<void> {
    try {
      await this.run();
    } catch (err) {
      console.error("[BackgroundCognition] run error:", err);
    }
  }

  private async run(): Promise<void> {
    const stats = await this.mgr.reflect("default");
    const agentIds = ["default"]; // future: enumerate agents from store

    for (const agent_id of agentIds) {
      try {
        await this.processAgent(agent_id);
      } catch (err) {
        console.error(
          `[BackgroundCognition] error processing agent ${agent_id}:`,
          err,
        );
      }
    }

    // Log cognition summary to working memory (1h TTL)
    const summary = `Background cognition ran at ${new Date().toISOString()}. Stats: episodic=${stats.counts.episodic}, semantic=${stats.counts.semantic}, working=${stats.counts.working}`;
    await this.mgr.remember({
      content: summary,
      agent_id: "system",
      type: "working",
      ttl_seconds: 3600,
      importance: 0.1,
      title: "Cognition cycle log",
    });
  }

  private async processAgent(agent_id: string): Promise<void> {
    // Find low-importance, older episodic memories as candidates
    const recalled = await this.mgr.recall({
      query: "old low importance memory",
      agent_id,
      type: "episodic",
      limit: 30,
      min_importance: 0,
    });

    const candidates = recalled.memories.filter((m) => {
      const ageDays =
        (Date.now() - new Date(m.timestamp).getTime()) / (1000 * 60 * 60 * 24);
      return m.importance < 0.3 && ageDays > 7;
    });

    if (candidates.length === 0) return;

    // Ask InnerThought for decisions
    const list = candidates
      .map(
        (m, i) =>
          `${i + 1}. [${m.id}] (importance: ${m.importance.toFixed(2)}) ${m.content.slice(0, 120)}`,
      )
      .join("\n");

    const prompt = `You are managing a memory system. Review these low-importance, older memories and decide what to do with each.

Actions:
- forget: permanently delete (irrelevant, outdated, trivial)
- consolidate: merge with related memories during next consolidation pass
- promote: elevate to semantic (contains reusable knowledge)
- keep: leave unchanged

Memories:
${list}

Respond with only a JSON array: [{"id": "epi_abc", "action": "forget"}, ...]`;

    const response = await this.innerThought.reason(prompt);

    let decisions: CognitionDecision[] = [];
    if (response) {
      try {
        decisions = JSON.parse(response) as CognitionDecision[];
      } catch {
        // malformed — fall back to running consolidation only
        await this.consolidator.run(agent_id);
        return;
      }
    }

    const validActions: CognitionAction[] = [
      "forget",
      "consolidate",
      "promote",
      "keep",
    ];
    for (const d of decisions) {
      if (!validActions.includes(d.action)) continue;
      try {
        if (d.action === "forget") {
          await this.mgr.forget(d.id);
        } else if (d.action === "consolidate" || d.action === "promote") {
          // Mark for consolidation — the Consolidator will handle it on next run
          await this.mgr.episodic.markConsolidated(d.id, 0);
        }
        // 'keep' — no action
      } catch (err) {
        console.error(
          `[BackgroundCognition] action ${d.action} failed for ${d.id}:`,
          err,
        );
      }
    }
  }
}
