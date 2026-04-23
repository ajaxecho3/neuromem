/**
 * Consolidator — Systems Consolidation analog
 *
 * Periodically:
 *   - Clusters episodic memories by shared tags
 *   - Abstracts clusters into semantic memories (via LLM if configured)
 *   - Forgets low-importance, stale memories
 */

import type { ConsolidationReport, Memory } from "../types/index.js";
import { MemoryManager } from "../stores/MemoryManager.js";
import type { InnerThought } from "../cognition/InnerThought.js";
import { shouldForgetByRetention } from "../utils/retention.js";

export interface ConsolidatorOptions {
  forgetThreshold?: number; // default 0.2
  forgetAfterDays?: number; // default 30
  clusterMinSize?: number; // default 3
  innerThought?: InnerThought;
  summarize?: (memories: Memory[]) => Promise<{
    title: string;
    content: string;
    tags: string[];
  }>;
}

export class Consolidator {
  private opts: Required<
    Omit<ConsolidatorOptions, "summarize" | "innerThought">
  > &
    Pick<ConsolidatorOptions, "summarize">;

  constructor(
    private mgr: MemoryManager,
    opts: ConsolidatorOptions = {},
  ) {
    this.opts = {
      forgetThreshold: opts.forgetThreshold ?? 0.2,
      forgetAfterDays: opts.forgetAfterDays ?? 30,
      clusterMinSize: opts.clusterMinSize ?? 3,
      summarize: opts.summarize,
    };
    this.innerThought = opts.innerThought;
  }

  private innerThought?: InnerThought;

  async run(agent_id: string): Promise<ConsolidationReport> {
    const start = Date.now();
    const report: ConsolidationReport = {
      processed: 0,
      consolidated: 0,
      forgotten: 0,
      new_semantic: 0,
      new_skills: 0,
      duration_ms: 0,
    };

    const candidates = await this.mgr.episodic.listForConsolidation(agent_id);
    report.processed = candidates.length;

    // 0. Apply time-based decay before processing
    await this.mgr.applyDecay(agent_id);

    // 1. Forget stale + low-importance
    const stale = candidates.filter((m) => this.shouldForget(m));
    for (const m of stale) {
      await this.mgr.forget(m.id);
      report.forgotten += 1;
    }
    const surviving = candidates.filter((m) => !stale.includes(m));

    // 2. Cluster by shared tags
    const clusters = this.clusterByTags(surviving);
    for (const cluster of clusters) {
      if (cluster.memories.length < this.opts.clusterMinSize) continue;
      const abstracted = await this.abstractToSemantic(cluster, agent_id);
      if (abstracted) {
        report.new_semantic += 1;
        for (const m of cluster.memories) {
          await this.mgr.episodic.markConsolidated(m.id, 1);
          await this.mgr.associate(abstracted.id, m.id);
          report.consolidated += 1;
        }
      }
    }

    // 3. Partial consolidation for high-importance survivors
    for (const m of surviving) {
      if (m.consolidation_level < 0.5 && m.importance > 0.7) {
        await this.mgr.episodic.markConsolidated(m.id, 0.5);
      }
    }

    await this.mgr.episodic.logConsolidation(agent_id, report);
    report.duration_ms = Date.now() - start;
    return report;
  }

  private shouldForget(m: Memory): boolean {
    if (m.importance >= this.opts.forgetThreshold) return false;
    const ageDays =
      (Date.now() - new Date(m.last_accessed ?? m.timestamp).getTime()) /
      (1000 * 60 * 60 * 24);
    if (ageDays < this.opts.forgetAfterDays) return false;
    if (m.access_count >= 2) return false;
    // Additional guard: only forget if retention is also near zero
    return shouldForgetByRetention(m);
  }

  private clusterByTags(
    memories: Memory[],
  ): { tag: string; memories: Memory[] }[] {
    const byTag = new Map<string, Memory[]>();
    for (const m of memories) {
      for (const tag of m.tags) {
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag)!.push(m);
      }
    }
    return [...byTag.entries()].map(([tag, memories]) => ({ tag, memories }));
  }

  private async abstractToSemantic(
    cluster: { tag: string; memories: Memory[] },
    agent_id: string,
  ): Promise<Memory | null> {
    // ─── Conflict-aware consolidation ─────────────────────────
    // Before abstracting, detect contradictions within the cluster.
    // If LLM available, ask it to identify conflicts. Otherwise use
    // heuristic negation detection. Flag but still consolidate — don't silently merge.
    let conflictWarning = "";
    if (this.innerThought && cluster.memories.length > 1) {
      const memList = cluster.memories
        .map((m, i) => `${i + 1}. ${m.content.slice(0, 150)}`)
        .join("\n");
      const conflictPrompt = `Do any of these memories directly contradict each other? Answer YES or NO only.
${memList}`;
      const answer = await this.innerThought.reason(conflictPrompt);
      if (answer?.trim().toUpperCase().startsWith("YES")) {
        conflictWarning =
          "\n\n⚠️ Note: Conflicting statements detected in source memories — verify before relying on this summary.";
      }
    } else {
      // Heuristic: if any two memories have opposing negation patterns on similar content
      const negation =
        /\b(not|never|no longer|isn't|aren't|doesn't|don't|won't|false)\b/i;
      const hasNeg = cluster.memories.filter((m) => negation.test(m.content));
      const hasPos = cluster.memories.filter((m) => !negation.test(m.content));
      if (hasNeg.length > 0 && hasPos.length > 0) {
        conflictWarning =
          "\n\n⚠️ Note: Possible conflicting statements in source memories.";
      }
    }
    // ──────────────────────────────────────────────────────────

    let title: string, content: string, tags: string[];

    if (this.opts.summarize) {
      ({ title, content, tags } = await this.opts.summarize(cluster.memories));
    } else {
      title = `Abstracted: ${cluster.tag}`;
      content = [
        `# Consolidated memory — #${cluster.tag}`,
        ``,
        `Derived from ${cluster.memories.length} episodic memories.`,
        ``,
        `## Source fragments`,
        ...cluster.memories.map((m) => `- ${m.title}`),
      ].join("\n");
      tags = [cluster.tag, "consolidated"];
    }

    // LLM summarization when available and no custom summarize callback
    if (this.innerThought && !this.opts.summarize) {
      const memList = cluster.memories
        .map((m) => `- ${m.content.slice(0, 200)}`)
        .join("\n");
      const prompt = `Summarize these related memories into one concise factual statement (max 2 sentences).
Memories:
${memList}

Respond with only the summary text, no labels or formatting.`;

      const summary = await this.innerThought.reason(prompt);
      if (summary) {
        content = summary + conflictWarning;
        title = title || `Summary: ${cluster.tag}`;
      }
    } else if (conflictWarning) {
      content += conflictWarning;
    }

    const avgImportance =
      cluster.memories.reduce((s, m) => s + m.importance, 0) /
      cluster.memories.length;

    const created = await this.mgr.semantic.write({
      type: "semantic",
      agent_id,
      title,
      content,
      tags,
      importance: Math.min(1, avgImportance + 0.1),
      topic: cluster.tag,
    });

    await this.mgr.associations.registerMemory({
      id: created.id,
      agent_id,
      type: "semantic",
      title: created.title,
      tags: created.tags,
    });

    return created;
  }
}
