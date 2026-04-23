import type { MemoryType } from "../types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const COLOR_MAP: Record<MemoryType, string> = {
  working: "border-blue-500/30 bg-blue-500/10 text-blue-400",
  episodic: "border-green-500/30 bg-green-500/10 text-green-400",
  semantic: "border-purple-500/30 bg-purple-500/10 text-purple-400",
  procedural: "border-orange-500/30 bg-orange-500/10 text-orange-400",
  affective: "border-red-500/30 bg-red-500/10 text-red-400",
  shared: "border-teal-500/30 bg-teal-500/10 text-teal-400",
};

const GLOW_MAP: Record<MemoryType, string> = {
  working: "0 0 6px rgba(59, 130, 246, 0.25)",
  episodic: "0 0 6px rgba(34, 197, 94, 0.25)",
  semantic: "0 0 6px rgba(168, 85, 247, 0.25)",
  procedural: "0 0 6px rgba(249, 115, 22, 0.25)",
  affective: "0 0 6px rgba(239, 68, 68, 0.25)",
  shared: "0 0 6px rgba(20, 184, 166, 0.25)",
};

export function MemoryTypeBadge({ type }: { type: MemoryType }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-mono text-[10px] tracking-wide",
        COLOR_MAP[type] ?? "border-border text-muted-foreground",
      )}
      style={{ boxShadow: GLOW_MAP[type] }}
    >
      {type}
    </Badge>
  );
}
