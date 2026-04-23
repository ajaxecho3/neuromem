import { useState } from "react";
import { buildContext } from "../api/graph";
import { AgentSelector } from "../components/AgentSelector";
import { MemoryTypeBadge } from "../components/MemoryTypeBadge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import type { Memory } from "@/types";

export function ContextBuilder() {
  const [agent, setAgent] = useState("default");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(8);
  const [result, setResult] = useState<{
    context: string;
    token_estimate: number;
    memories: Array<Memory & { importance: number; title?: string }>;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await buildContext(query, agent, limit);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to build context");
    } finally {
      setLoading(false);
    }
  };

  const copy = () => {
    if (!result) return;
    navigator.clipboard.writeText(result.context).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-2xl text-foreground mb-1">
        Context Builder
      </h1>
      <p className="text-sm text-muted-foreground mb-5">
        Preview what memories an LLM would receive for a given query.
      </p>

      <div className="bg-card rounded-lg border border-border p-5 space-y-4">
        <div className="flex gap-3 flex-wrap">
          <AgentSelector value={agent} onChange={setAgent} />
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Top memories:
            <Select
              value={limit.toString()}
              onValueChange={(e) => setLimit(Number(e))}
            >
              {[4, 6, 8, 12, 16].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </label>
        </div>

        <div>
          <Label className="text-xs font-medium text-muted-foreground mb-1 block">
            Query
          </Label>
          <Textarea
            rows={3}
            value={query}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
              setQuery(e.target.value)
            }
            onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
            }}
            placeholder="What is the user currently working on?"
          />
          <div className="text-xs text-muted-foreground mt-1">
            ⌘↵ / Ctrl↵ to run
          </div>
        </div>

        <Button onClick={run} disabled={loading || !query.trim()}>
          {loading ? "Building..." : "Build Context"}
        </Button>

        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>

      {result && (
        <>
          {/* Sources */}
          <div className="mt-5">
            <h2 className="text-sm font-semibold text-foreground mb-2">
              Retrieved memories ({result.memories.length})
            </h2>
            <div className="space-y-2">
              {result.memories.map((m, i) => (
                <div
                  key={m.id ?? i}
                  className="bg-card rounded-lg border border-border px-4 py-3 flex items-start gap-3"
                >
                  <span className="text-xs text-muted-foreground w-4 mt-0.5 shrink-0">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <MemoryTypeBadge type={m.type} />
                      {m.title && (
                        <span className="text-xs font-medium text-foreground truncate">
                          {m.title}
                        </span>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground shrink-0">
                        {(m.importance * 100).toFixed(0)}%
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {m.content}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Context string */}
          <div className="mt-5">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-foreground">
                Context string
              </h2>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  ~{result.token_estimate.toLocaleString()} tokens
                </span>
                <Button variant="outline" size="sm" onClick={copy}>
                  {copied ? "✓ Copied" : "Copy"}
                </Button>
              </div>
            </div>
            <pre className="bg-muted rounded-lg border border-border p-4 text-xs text-foreground/80 whitespace-pre-wrap font-mono overflow-auto max-h-96">
              {result.context}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}
