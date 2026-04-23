import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getReflect, runConsolidate } from "../api/agents";
import { AgentSelector } from "../components/AgentSelector";
import { ErrorBanner } from "../components/ErrorBanner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp } from "lucide-react";

const STAT_COLORS: Record<string, string> = {
  Episodic: "#22c55e",
  Semantic: "#a855f7",
  Working: "#3b82f6",
  Procedural: "#f97316",
  "Graph nodes": "#00d4c8",
  "Graph edges": "#f59e0b",
};

export function AgentDashboard() {
  const [agent, setAgent] = useState("default");
  const qc = useQueryClient();

  const { data, error } = useQuery({
    queryKey: ["reflect", agent],
    queryFn: () => getReflect(agent),
  });

  const { mutate: consolidate, isPending, isSuccess, isError } = useMutation({
    mutationFn: () => runConsolidate(agent),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reflect", agent] }),
  });

  const stats = data
    ? [
        { label: "Episodic", value: data.counts.episodic },
        { label: "Semantic", value: data.counts.semantic },
        { label: "Working", value: data.counts.working },
        { label: "Procedural", value: data.counts.procedural },
        { label: "Graph nodes", value: data.graph.nodes },
        { label: "Graph edges", value: data.graph.edges },
      ]
    : [];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-2xl text-foreground">Dashboard</h1>
        <AgentSelector value={agent} onChange={setAgent} />
      </div>

      <ErrorBanner error={error as Error | null} />

      <div className="grid grid-cols-3 gap-3 mb-6 animate-stagger">
        {stats.map(({ label, value }) => (
          <Card
            key={label}
            className="bg-card border-border/30 hover:border-border/60 transition-colors"
          >
            <CardHeader className="pb-1 pt-4 px-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground uppercase tracking-widest">{label}</span>
                <TrendingUp size={14} style={{ color: STAT_COLORS[label] }} className="opacity-60" />
              </div>
            </CardHeader>
            <CardContent className="pb-4 px-4">
              <CardTitle className="text-3xl font-display text-foreground">
                {value ?? "—"}
              </CardTitle>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="bg-card border-border/30">
        <CardContent className="p-4 flex items-center gap-4">
          <div>
            <p className="font-medium text-foreground">Sleep-cycle Consolidation</p>
            <p className="text-sm text-muted-foreground">
              Compress episodic memories → semantic, forget stale entries
            </p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <button
              onClick={() => consolidate()}
              disabled={isPending}
              className="btn-primary"
            >
              {isPending ? "Running..." : "Run Consolidation"}
            </button>
            {isSuccess && <span className="text-green-500 text-sm">Done ✓</span>}
            {isError && <span className="text-destructive text-sm">Failed</span>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
