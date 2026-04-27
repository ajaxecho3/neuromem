import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { getMemories, createMemory } from "../api/memories";
import { MemoryTypeBadge } from "../components/MemoryTypeBadge";
import { ImportanceBar } from "../components/ImportanceBar";
import { AgentSelector } from "../components/AgentSelector";
import { ErrorBanner } from "../components/ErrorBanner";
import { EmptyState } from "../components/EmptyState";
import { StatsStrip } from "../components/StatsStrip";
import { ProjectedSavings } from "../components/ProjectedSavings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import type { ColumnDef } from "@tanstack/react-table";
import type { MemoryType, Memory } from "../types";
import { DataGrid } from "@/components/DataGrid";

const d = Date.now();

/** Shows a decay trend arrow based on decay_rate × days-since-last-access */
function DecayIndicator({
  importance,
  decayRate,
  lastAccessed,
}: {
  importance: number;
  decayRate: number;
  lastAccessed: string;
}) {
  const rawDate = d - new Date(lastAccessed).getTime();
  const daysSince = rawDate / (1000 * 60 * 60 * 24);
  const projected = Math.max(0, importance - decayRate * daysSince);
  const delta = projected - importance;

  if (Math.abs(delta) < 0.01) return null; // no visible change

  const isDecaying = delta < -0.05;
  const isFading = delta < 0;

  return (
    <span
      title={`Projected importance in 7d: ${(projected * 100).toFixed(0)}%`}
      className={`text-xs ${isDecaying ? "text-red-400" : isFading ? "text-yellow-400" : "text-green-400"}`}
    >
      {isDecaying ? "↓↓" : isFading ? "↓" : "→"}
    </span>
  );
}

const TYPES: MemoryType[] = [
  "working",
  "episodic",
  "semantic",
  "procedural",
  "affective",
  "shared",
];

interface CreateForm {
  content: string;
  title: string;
  type: string;
  importance: number;
  tags: string;
}

const DEFAULT_FORM: CreateForm = {
  content: "",
  title: "",
  type: "",
  importance: 0.5,
  tags: "",
};

export function MemoryBrowser() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [agent, setAgent] = useState("all");
  const [type, setType] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [minImportance, setMinImportance] = useState(0);
  const [tagFilter, setTagFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateForm>(DEFAULT_FORM);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const limit = 20;

  const { data, error, isLoading } = useQuery({
    queryKey: [
      "memories",
      agent,
      type === "default" ? "" : type,
      q,
      page,
      minImportance,
      tagFilter,
    ],
    queryFn: () =>
      getMemories({
        agent_id: agent,
        type: type === "default" ? undefined : type,
        page,
        limit,
        min_importance: minImportance > 0 ? minImportance : undefined,
        tags: tagFilter || undefined,
      }),
  });

  const columns: ColumnDef<Memory>[] = [
    {
      accessorKey: "type",
      header: "Type",
      cell: ({ row }) => <MemoryTypeBadge type={row.original.type} />,
    },
    {
      accessorKey: "content",
      header: "Content",
      cell: ({ row }) => (
        <div
          className="cursor-pointer"
          onClick={() => navigate(`/memory/${row.original.id}`)}
        >
          <div className="truncate max-w-sm">
            {row.original.title || row.original.content}
          </div>
          {row.original.tags?.length > 0 && (
            <div className="text-xs text-muted-foreground mt-0.5">
              {row.original.tags
                .slice(0, 3)
                .map((t) => `#${t}`)
                .join(" ")}
            </div>
          )}
        </div>
      ),
    },
    {
      accessorKey: "agent_id",
      header: "Agent",
      cell: ({ row }) => (
        <span className="text-gray-500 dark:text-gray-400">
          {row.original.agent_id}
        </span>
      ),
    },
    {
      accessorKey: "importance",
      header: "Importance",
      cell: ({ row }) => (
        <div className="flex items-center gap-1.5">
          <ImportanceBar value={row.original.importance} />
          <DecayIndicator
            importance={row.original.importance}
            decayRate={row.original.decay_rate ?? 0.005}
            lastAccessed={row.original.last_accessed ?? row.original.timestamp}
          />
        </div>
      ),
    },
    {
      accessorKey: "timestamp",
      header: "Created",
      cell: ({ row }) => (
        <span className="text-muted-foreground whitespace-nowrap font-ibm-mono text-xs">
          {new Date(row.original.timestamp).toLocaleString()}
        </span>
      ),
    },
  ];

  // Extract all unique tags from loaded memories for chips
  const allTags = useMemo(() => {
    if (!data) return [];
    const set = new Set<string>();
    for (const m of data.memories) {
      for (const t of m.tags ?? []) set.add(t);
    }
    return Array.from(set).sort();
  }, [data]);

  const resetFilters = () => {
    setType("");
    setQ("");
    setPage(1);
    setMinImportance(0);
    setTagFilter("");
  };

  const handleCreate = async () => {
    if (!form.content.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await createMemory({
        content: form.content,
        title: form.title || undefined,
        type: form.type || undefined,
        importance: form.importance,
        tags: form.tags
          ? form.tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : [],
        agent_id: agent,
      });
      setShowCreate(false);
      setForm(DEFAULT_FORM);
      queryClient.invalidateQueries({ queryKey: ["memories"] });
    } catch (e) {
      setCreateError(
        e instanceof Error ? e.message : "Failed to create memory",
      );
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-display text-2xl text-foreground">Memories</h1>
        <Button onClick={() => setShowCreate(true)}>+ New Memory</Button>
      </div>

      {/* Headline numbers: total stored + last-bench token savings */}
      <StatsStrip />

      {/* How savings grow as the memory store grows */}
      <ProjectedSavings />

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-3">
        <AgentSelector
          value={agent}
          onChange={(v) => {
            setAgent(v);
            setPage(1);
          }}
        />
        <Select
          value={type}
          onValueChange={(e) => {
            setType(e);
            setPage(1);
          }}
        >
          <SelectTrigger className="h-9 min-w-32">
            <SelectValue placeholder="Filter by type" />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="default">All types</SelectItem>
            {TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="search"
          placeholder="Search content..."
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          className="w-56 h-9"
        />
      </div>

      {/* Importance slider + tag filter */}
      <div className="flex flex-wrap items-center gap-4 mb-3 text-sm">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Min importance:
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={minImportance}
            onChange={(e) => {
              setMinImportance(parseFloat(e.target.value));
              setPage(1);
            }}
            className="w-28"
          />
          <span className="text-muted-foreground w-8">
            {Math.round(minImportance * 100)}%
          </span>
        </label>
        {(type || q || minImportance > 0 || tagFilter) && (
          <button
            onClick={resetFilters}
            className="text-xs text-indigo-500 hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Tag chips */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => {
                setTagFilter(tagFilter === tag ? "" : tag);
                setPage(1);
              }}
              className={`px-2 py-0.5 rounded-full text-xs border transition-colors ${
                tagFilter === tag
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted text-muted-foreground border-border hover:bg-muted/80"
              }`}
            >
              #{tag}
            </button>
          ))}
        </div>
      )}

      <ErrorBanner error={error as Error | null} />

      {isLoading && <p className="text-sm text-gray-400">Loading...</p>}

      {data && data.memories.length === 0 && (
        <EmptyState message="No memories found. Try adjusting filters." />
      )}

      {data && data.memories.length > 0 && (
        <>
          <DataGrid columns={columns} data={data.memories} />
          <div className="flex items-center justify-between mt-3 text-sm text-muted-foreground">
            <span>
              {Math.min((page - 1) * limit + 1, data.total)}–
              {Math.min(page * limit, data.total)} of {data.total}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(1)}
                disabled={page === 1}
                className="px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
              >
                «
              </button>
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ‹
              </button>
              <span className="px-3">
                Page {page} of {Math.ceil(data.total / limit)}
              </span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page * limit >= data.total}
                className="px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ›
              </button>
              <button
                onClick={() => setPage(Math.ceil(data.total / limit))}
                disabled={page * limit >= data.total}
                className="px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
              >
                »
              </button>
            </div>
          </div>
        </>
      )}

      {/* Create memory modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-card rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6 border border-border">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-foreground">
                New Memory
              </h2>
              <button
                onClick={() => {
                  setShowCreate(false);
                  setForm(DEFAULT_FORM);
                  setCreateError(null);
                }}
                className="text-muted-foreground hover:text-foreground text-xl"
              >
                ×
              </button>
            </div>

            {createError && (
              <p className="text-sm text-red-500 mb-3">{createError}</p>
            )}

            <div className="space-y-3">
              <div>
                <Label className="text-xs font-medium text-muted-foreground mb-1 block">
                  Content *
                </Label>
                <Textarea
                  rows={4}
                  value={form.content}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                    setForm({ ...form, content: e.target.value })
                  }
                  placeholder="What do you want to remember?"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs font-medium text-muted-foreground mb-1 block">
                    Title
                  </Label>
                  <Input
                    value={form.title}
                    onChange={(e) =>
                      setForm({ ...form, title: e.target.value })
                    }
                    placeholder="Optional"
                  />
                </div>
                <div>
                  <Label className="text-xs font-medium text-muted-foreground mb-1 block">
                    Type
                  </Label>
                  <Select
                    value={form.type}
                    onValueChange={(e) => setForm({ ...form, type: e })}
                  >
                    <option value="">Auto-detect</option>
                    {TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              <div>
                <Label className="text-xs font-medium text-muted-foreground mb-1 block">
                  Importance: {Math.round(form.importance * 100)}%
                </Label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={form.importance}
                  onChange={(e) =>
                    setForm({ ...form, importance: parseFloat(e.target.value) })
                  }
                  className="w-full"
                />
              </div>
              <div>
                <Label className="text-xs font-medium text-muted-foreground mb-1 block">
                  Tags (comma-separated)
                </Label>
                <Input
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  placeholder="e.g. project, idea, review"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-5">
              <Button
                variant="outline"
                onClick={() => {
                  setShowCreate(false);
                  setForm(DEFAULT_FORM);
                  setCreateError(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={creating || !form.content.trim()}
              >
                {creating ? "Saving..." : "Save Memory"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
