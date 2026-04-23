import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getMemory,
  updateMemory,
  deleteMemory,
  getVersionHistory,
} from "../api/memories";
import { MemoryTypeBadge } from "../components/MemoryTypeBadge";
import { ErrorBanner } from "../components/ErrorBanner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function MemoryDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: memory, error } = useQuery({
    queryKey: ["memory", id],
    queryFn: () => getMemory(id!),
    enabled: !!id,
  });

  const [importance, setImportance] = useState<number | null>(null);
  const [tagsInput, setTagsInput] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const { data: history } = useQuery({
    queryKey: ["memory-history", id],
    queryFn: () => getVersionHistory(id!),
    enabled: showHistory && !!id,
  });

  const currentImportance = importance ?? memory?.importance ?? 0.5;
  const currentTags = tagsInput ?? memory?.tags.join(", ") ?? "";
  const currentTitle = title ?? memory?.title ?? "";

  const { mutate: save, isPending: saving } = useMutation({
    mutationFn: () =>
      updateMemory(id!, {
        importance: currentImportance,
        tags: currentTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        title: currentTitle || undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memory", id] }),
  });

  const { mutate: remove, isPending: deleting } = useMutation({
    mutationFn: () => deleteMemory(id!),
    onSuccess: () => navigate("/"),
  });

  if (!memory)
    return <div className="text-sm text-muted-foreground">Loading...</div>;

  const provenance: { created_by?: string; session_id?: string } =
    (memory as any).metadata ?? {};

  return (
    <div className="max-w-2xl">
      <button
        onClick={() => navigate(-1)}
        className="text-sm text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1"
      >
        ← Back
      </button>

      <ErrorBanner error={error as Error | null} />

      <div className="bg-card rounded-lg border border-border p-6 space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <MemoryTypeBadge type={memory.type} />
          <span className="text-xs text-muted-foreground font-mono">
            {memory.id}
          </span>
          {memory.conflicting_ids && memory.conflicting_ids.length > 0 && (
            <div className="flex items-center gap-1.5 ml-auto">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-destructive/10 border border-destructive/30 text-destructive rounded-full text-xs font-medium">
                ⚠ {memory.conflicting_ids.length} conflict
                {memory.conflicting_ids.length > 1 ? "s" : ""}
              </span>
              <span className="text-xs text-gray-400">with:</span>
              {memory.conflicting_ids.slice(0, 3).map((cid) => (
                <button
                  key={cid}
                  onClick={() => navigate(`/memory/${cid}`)}
                  className="text-xs text-red-500 hover:underline font-mono"
                >
                  {cid.slice(0, 12)}…
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <Label className="text-xs font-medium text-muted-foreground mb-1 block">
            Title
          </Label>
          <Input
            type="text"
            value={currentTitle}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="(no title)"
          />
        </div>

        <div>
          <Label className="text-xs font-medium text-muted-foreground mb-1 block">
            Content
          </Label>
          <p className="text-sm text-foreground/80 bg-muted/50 rounded-md p-3 whitespace-pre-wrap">
            {memory.content}
          </p>
        </div>

        <div>
          <Label className="text-xs font-medium text-muted-foreground mb-1 block">
            Importance: {currentImportance.toFixed(2)}
          </Label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={currentImportance}
            onChange={(e) => setImportance(parseFloat(e.target.value))}
            className="w-full"
          />
        </div>

        <div>
          <Label className="text-xs font-medium text-muted-foreground mb-1 block">
            Tags (comma-separated)
          </Label>
          <Input
            type="text"
            value={currentTags}
            onChange={(e) => setTagsInput(e.target.value)}
          />
        </div>

        <div className="flex gap-2 text-xs text-muted-foreground flex-wrap">
          <span>Valence: {memory.valence}</span>
          <span>·</span>
          <span>Arousal: {memory.arousal.toFixed(2)}</span>
          <span>·</span>
          <span>Accessed: {memory.access_count}×</span>
          {memory.last_accessed && (
            <>
              <span>·</span>
              <span>
                Last: {new Date(memory.last_accessed).toLocaleString()}
              </span>
            </>
          )}
          <span>·</span>
          <span>Created: {new Date(memory.timestamp).toLocaleString()}</span>
        </div>

        {/* Provenance */}
        {(provenance.created_by || provenance.session_id) && (
          <div className="rounded-md bg-muted/50 border border-border px-3 py-2 text-xs text-muted-foreground space-y-0.5">
            <div className="font-medium text-foreground/80 mb-1">
              Provenance
            </div>
            {provenance.created_by && (
              <div>
                Created by:{" "}
                <span className="text-foreground/80">
                  {provenance.created_by}
                </span>
              </div>
            )}
            {provenance.session_id && (
              <div>
                Session:{" "}
                <span className="text-foreground/80 font-mono">
                  {provenance.session_id}
                </span>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Button onClick={() => save()} disabled={saving}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>

          {!confirmDelete ? (
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(true)}
              className="border-destructive/40 text-destructive hover:bg-destructive/10"
            >
              Delete
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-destructive">Are you sure?</span>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => remove()}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Yes, delete"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Version History */}
      <div className="mt-4 bg-card rounded-lg border border-border overflow-hidden">
        <button
          onClick={() => setShowHistory((v) => !v)}
          className="w-full flex items-center justify-between px-5 py-3 text-sm font-medium text-foreground hover:bg-muted/40"
        >
          <span>Version History</span>
          <span className="text-gray-400 dark:text-gray-500">
            {showHistory ? "▲" : "▼"}
          </span>
        </button>

        {showHistory && (
          <div className="border-t border-border divide-y divide-border">
            {!history && (
              <p className="px-5 py-3 text-sm text-muted-foreground">
                Loading history...
              </p>
            )}
            {history && history.length === 0 && (
              <p className="px-5 py-3 text-sm text-muted-foreground">
                No previous versions. Save changes to create a version.
              </p>
            )}
            {history &&
              history.map((v) => (
                <div key={v.version} className="px-5 py-3 text-xs">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-foreground">
                      v{v.version}
                    </span>
                    <span className="text-muted-foreground">
                      {new Date(v.archived_at).toLocaleString()}
                    </span>
                  </div>
                  {v.title && (
                    <div className="text-foreground/80 mb-0.5">{v.title}</div>
                  )}
                  <div className="text-muted-foreground line-clamp-2">
                    {v.content}
                  </div>
                  <div className="flex gap-3 mt-1 text-muted-foreground">
                    <span>Importance: {(v.importance * 100).toFixed(0)}%</span>
                    {v.reason && <span>· {v.reason}</span>}
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
