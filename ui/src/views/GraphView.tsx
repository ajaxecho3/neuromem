import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import ForceGraph2D from "react-force-graph-2d";
import type { NodeObject } from "react-force-graph-2d";
import { getGraph, getSpreadingActivation } from "../api/graph";
import { getMemories } from "../api/memories";
import { AgentSelector } from "../components/AgentSelector";
import { ErrorBanner } from "../components/ErrorBanner";
import { MemoryTypeBadge } from "../components/MemoryTypeBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MemoryType, GraphNode, GraphLink } from "../types";

const NODE_COLORS: Record<MemoryType, string> = {
  working: "#3b82f6",
  episodic: "#22c55e",
  semantic: "#a855f7",
  procedural: "#f97316",
  affective: "#ef4444",
  shared: "#14b8a6",
};

type GNode = NodeObject<GraphNode>;
type GLink = GraphLink;

interface Tooltip {
  x: number;
  y: number;
  node: GraphNode;
}

const MINIMAP_W = 140;
const MINIMAP_H = 100;

function MinimapOverlay({
  nodes: _nodes,
  graphRef,
  nodeColors,
  tick: _tick,
}: {
  nodes: GraphNode[];
  graphRef: React.RefObject<any>;
  nodeColors: Record<MemoryType, string>;
  tick: number;
}) {
  // Get live node positions from ForceGraph internals
  const liveNodes: Array<{
    x: number;
    y: number;
    type: MemoryType;
    importance: number;
  }> = [];
  if (graphRef.current) {
    try {
      const gd = graphRef.current.graphData() as { nodes: any[] };
      for (const n of gd.nodes) {
        if (n.x != null && n.y != null) {
          liveNodes.push({
            x: n.x,
            y: n.y,
            type: n.type,
            importance: n.importance ?? 0.5,
          });
        }
      }
    } catch {
      // graph not ready
    }
  }

  if (liveNodes.length === 0) return null;

  const xs = liveNodes.map((n) => n.x);
  const ys = liveNodes.map((n) => n.y);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs);
  const minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const pad = 8;

  const toMX = (x: number) =>
    pad + ((x - minX) / rangeX) * (MINIMAP_W - pad * 2);
  const toMY = (y: number) =>
    pad + ((y - minY) / rangeY) * (MINIMAP_H - pad * 2);

  return (
    <div
      className="absolute top-3 right-3 bg-white/90 dark:bg-gray-900/90 border border-gray-200 dark:border-gray-700 rounded-lg shadow overflow-hidden"
      style={{ width: MINIMAP_W, height: MINIMAP_H }}
    >
      <svg width={MINIMAP_W} height={MINIMAP_H}>
        {liveNodes.map((n, i) => (
          <circle
            key={i}
            cx={toMX(n.x)}
            cy={toMY(n.y)}
            r={Math.max(2, n.importance * 4)}
            fill={nodeColors[n.type] ?? "#6b7280"}
            opacity={0.75}
          />
        ))}
      </svg>
      <div
        className="absolute bottom-1 left-0 right-0 text-center text-muted-foreground"
        style={{ fontSize: 9 }}
      >
        {liveNodes.length} nodes
      </div>
    </div>
  );
}

export function GraphView() {
  const navigate = useNavigate();
  const graphRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastClickRef = useRef<{ id: string; time: number } | null>(null);

  const [agent, setAgent] = useState("default");
  const [search, setSearch] = useState("");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [activatedIds, setActivatedIds] = useState<Set<string>>(new Set());
  const [isActivating, setIsActivating] = useState(false);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const [showEdgeLabels, setShowEdgeLabels] = useState(false);
  const [timelineMode, setTimelineMode] = useState(false);
  const [showMinimap, setShowMinimap] = useState(false);
  const [minimapTick, setMinimapTick] = useState(0);

  // Refresh minimap while visible so it picks up settled node positions
  useEffect(() => {
    if (!showMinimap) return;
    const id = setInterval(() => setMinimapTick((t) => t + 1), 1500);
    return () => clearInterval(id);
  }, [showMinimap]);

  const { data, error } = useQuery({
    queryKey: ["graph", agent],
    queryFn: () => getGraph(agent),
  });

  const { data: episodicData } = useQuery({
    queryKey: ["episodic-timeline", agent],
    queryFn: () =>
      getMemories({ agent_id: agent, type: "episodic", limit: 100 }),
    enabled: timelineMode,
  });

  // Build adjacency set for focused node
  const focusedNeighbors = useMemo(() => {
    if (!focusedId || !data) return new Set<string>();
    const neighbors = new Set<string>([focusedId]);
    for (const link of data.links) {
      const src =
        typeof link.source === "object" ? (link.source as any).id : link.source;
      const tgt =
        typeof link.target === "object" ? (link.target as any).id : link.target;
      if (src === focusedId) neighbors.add(tgt);
      if (tgt === focusedId) neighbors.add(src);
    }
    return neighbors;
  }, [focusedId, data]);

  const nodeColor = useCallback(
    (node: GNode) => {
      const base = NODE_COLORS[node.type ?? "episodic"] ?? "#6b7280";
      // Dim if focused elsewhere and not a neighbor
      if (focusedId && !focusedNeighbors.has(node.id as string))
        return "#e5e7eb";
      // Highlight spreading activation results
      if (activatedIds.size > 0 && activatedIds.has(node.id as string))
        return "#fbbf24";
      // Dim non-search matches
      if (
        search &&
        !node.label?.toLowerCase().includes(search.toLowerCase()) &&
        !node.content?.toLowerCase().includes(search.toLowerCase())
      )
        return "#e5e7eb";
      return base;
    },
    [focusedId, focusedNeighbors, activatedIds, search],
  );

  const nodeVal = useCallback(
    (node: GNode) => (node.importance ?? 0.5) * 10 + 2,
    [],
  );

  const handleNodeClick = useCallback(
    (node: GNode) => {
      const now = Date.now();
      const last = lastClickRef.current;
      // Double-click detection: same node within 350ms
      if (last && last.id === node.id && now - last.time < 350) {
        lastClickRef.current = null;
        if (node.id) navigate(`/memory/${node.id}`);
        return;
      }
      lastClickRef.current = { id: node.id as string, time: now };
      // Toggle focus; clear spreading activation
      setActivatedIds(new Set());
      if (focusedId === node.id) {
        setFocusedId(null);
      } else {
        setFocusedId(node.id as string);
      }
    },
    [focusedId, navigate],
  );

  const handleNodeHover = useCallback(
    (node: GNode | null, _prevNode: GNode | null) => {
      if (!node) {
        setTooltip(null);
        return;
      }
      // Get canvas position from graph
      const canvas = containerRef.current?.querySelector("canvas");
      if (!canvas) {
        setTooltip(null);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      // ForceGraph stores screen coords in node.x/y after layout
      const grf = graphRef.current;
      if (!grf) {
        setTooltip(null);
        return;
      }
      const { x: sx, y: sy } = grf.graph2ScreenCoords(node.x ?? 0, node.y ?? 0);
      setTooltip({
        x: rect.left + sx,
        y: rect.top + sy,
        node: node as unknown as GraphNode,
      });
    },
    [],
  );

  const triggerSpreadingActivation = useCallback(async () => {
    if (!focusedId) return;
    setIsActivating(true);
    try {
      const memories = await getSpreadingActivation(focusedId, 2);
      setActivatedIds(new Set(memories.map((m) => m.id)));
    } finally {
      setIsActivating(false);
    }
  }, [focusedId]);

  const exportPng = useCallback(() => {
    const canvas = containerRef.current?.querySelector("canvas");
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `neuromem-graph-${agent}.png`;
    link.href = (canvas as HTMLCanvasElement).toDataURL("image/png");
    link.click();
  }, [agent]);

  const linkColor = useCallback(
    (link: GLink) => {
      if (!focusedId) return "#d1d5db";
      const src =
        typeof link.source === "object" ? (link.source as any).id : link.source;
      const tgt =
        typeof link.target === "object" ? (link.target as any).id : link.target;
      if (src === focusedId || tgt === focusedId) return "#6366f1";
      return "#e5e7eb";
    },
    [focusedId],
  );

  const linkWidth = useCallback(
    (link: GLink) => {
      if (!focusedId) return 1;
      const src =
        typeof link.source === "object" ? (link.source as any).id : link.source;
      const tgt =
        typeof link.target === "object" ? (link.target as any).id : link.target;
      return src === focusedId || tgt === focusedId ? 2 : 0.5;
    },
    [focusedId],
  );

  const linkCanvasObject = useCallback(
    (link: GLink, ctx: CanvasRenderingContext2D) => {
      if (!showEdgeLabels) return;
      const label = (link as any).label as string | undefined;
      if (!label) return;
      const start = link.source as any;
      const end = link.target as any;
      if (typeof start !== "object" || typeof end !== "object") return;
      const mx = (start.x + end.x) / 2;
      const my = (start.y + end.y) / 2;
      ctx.save();
      ctx.font = "4px sans-serif";
      ctx.fillStyle = "#9ca3af";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, mx, my);
      ctx.restore();
    },
    [showEdgeLabels],
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h1 className="font-display text-2xl text-foreground">
          Association Graph
        </h1>
        <div className="flex items-center gap-3 flex-wrap">
          <Input
            type="search"
            placeholder="Search nodes..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setFocusedId(null);
            }}
            className="w-44 h-9"
          />
          <AgentSelector
            value={agent}
            onChange={(v) => {
              setAgent(v);
              setFocusedId(null);
              setActivatedIds(new Set());
            }}
          />
          {focusedId && (
            <Button
              size="sm"
              onClick={triggerSpreadingActivation}
              disabled={isActivating}
              className="bg-amber-400 hover:bg-amber-500 text-amber-900"
            >
              {isActivating ? "Activating..." : "⚡ Spreading Activation"}
            </Button>
          )}
          {focusedId && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setFocusedId(null);
                setActivatedIds(new Set());
              }}
            >
              Clear focus
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={exportPng}>
            ↓ Export PNG
          </Button>
          <Button
            variant={showEdgeLabels ? "secondary" : "outline"}
            size="sm"
            onClick={() => setShowEdgeLabels((v) => !v)}
          >
            {showEdgeLabels ? "Hide" : "Show"} edge labels
          </Button>
          <Button
            variant={timelineMode ? "secondary" : "outline"}
            size="sm"
            onClick={() => setTimelineMode((v) => !v)}
          >
            {timelineMode ? "Graph view" : "📅 Timeline"}
          </Button>
          {!timelineMode && (
            <Button
              variant={showMinimap ? "secondary" : "outline"}
              size="sm"
              onClick={() => setShowMinimap((v) => !v)}
            >
              {showMinimap ? "Hide map" : "🗺 Minimap"}
            </Button>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-3">
        {(Object.entries(NODE_COLORS) as [MemoryType, string][]).map(
          ([type, color]) => (
            <div
              key={type}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <span
                className="w-3 h-3 rounded-full inline-block"
                style={{ backgroundColor: color }}
              />
              {type}
            </div>
          ),
        )}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground/60 ml-2">
          Click = focus · Double-click = open · ⚡ = spreading activation
        </div>
      </div>

      <ErrorBanner error={error as Error | null} />

      {data && data.nodes.length === 0 && (
        <div
          className="graph-canvas-bg rounded-lg border border-gray-200 dark:border-gray-700 flex flex-col items-center justify-center text-gray-500"
          style={{ height: 400 }}
        >
          <svg
            width="48"
            height="48"
            viewBox="0 0 48 48"
            fill="none"
            style={{ opacity: 0.3 }}
          >
            <circle
              cx="24"
              cy="12"
              r="5"
              stroke="currentColor"
              strokeWidth="2"
            />
            <circle
              cx="10"
              cy="36"
              r="5"
              stroke="currentColor"
              strokeWidth="2"
            />
            <circle
              cx="38"
              cy="36"
              r="5"
              stroke="currentColor"
              strokeWidth="2"
            />
            <line
              x1="24"
              y1="17"
              x2="10"
              y2="31"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <line
              x1="24"
              y1="17"
              x2="38"
              y2="31"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <line
              x1="15"
              y1="36"
              x2="33"
              y2="36"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
          <p
            className="text-sm mt-3 font-ibm-mono"
            style={{ color: "var(--color-accent)", opacity: 0.6 }}
          >
            No nodes — run the MCP server to load memories
          </p>
        </div>
      )}

      {/* Timeline mode */}
      {timelineMode && (
        <div className="bg-card rounded-lg border border-border overflow-hidden">
          <div className="px-4 py-3 border-b border-border text-sm font-medium text-foreground">
            Episodic Timeline
            {episodicData && (
              <span className="ml-2 text-muted-foreground font-normal">
                ({episodicData.total} events)
              </span>
            )}
          </div>
          {/* Horizontal scroll area */}
          <div className="overflow-x-auto py-6 px-4">
            {!episodicData && (
              <p className="text-sm text-muted-foreground">Loading...</p>
            )}
            {episodicData && episodicData.memories.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No episodic memories.
              </p>
            )}
            {episodicData &&
              episodicData.memories.length > 0 &&
              (() => {
                const sorted = [...episodicData.memories].sort(
                  (a, b) =>
                    new Date(a.timestamp).getTime() -
                    new Date(b.timestamp).getTime(),
                );
                return (
                  <div className="relative">
                    {/* Timeline rail */}
                    <div className="absolute left-0 right-0 top-10 h-0.5 bg-border" />
                    <div className="flex gap-0 min-w-max">
                      {sorted.map((m, i) => (
                        <div
                          key={m.id}
                          className="flex flex-col items-center w-36 cursor-pointer group"
                          onClick={() => navigate(`/memory/${m.id}`)}
                        >
                          {/* Dot on rail — alternating above/below */}
                          <div
                            className={`flex flex-col items-center ${i % 2 === 0 ? "flex-col" : "flex-col-reverse"}`}
                          >
                            <div
                              className={`text-xs text-center px-2 py-1.5 bg-card border border-border rounded-lg shadow-sm group-hover:border-primary/30 group-hover:shadow max-w-32 ${i % 2 === 0 ? "mb-2" : "mt-2"}`}
                            >
                              <div className="font-medium text-foreground truncate">
                                {m.title || m.content.slice(0, 40)}
                              </div>
                              <div className="text-muted-foreground mt-0.5">
                                {new Date(m.timestamp).toLocaleDateString()}
                              </div>
                            </div>
                            <div
                              className="w-3 h-3 rounded-full border-2 border-green-400 bg-white group-hover:bg-green-100"
                              style={{
                                transform: `scale(${0.7 + m.importance * 0.6})`,
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
          </div>
        </div>
      )}

      {/* Force graph */}
      {!timelineMode && data && data.nodes.length > 0 && (
        <div
          ref={containerRef}
          className="graph-canvas-bg rounded-lg border border-gray-200 dark:border-[#1e2535] overflow-hidden relative"
          style={{ height: 600 }}
        >
          <ForceGraph2D<GraphNode, GLink>
            ref={graphRef}
            graphData={data}
            nodeColor={nodeColor}
            nodeVal={nodeVal}
            nodeLabel=""
            onNodeClick={handleNodeClick}
            onNodeHover={handleNodeHover}
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkCanvasObjectMode={() => "after"}
            linkCanvasObject={linkCanvasObject}
            backgroundColor="transparent"
          />

          {/* Hover tooltip */}
          {tooltip && (
            <div
              className="fixed z-50 pointer-events-none bg-card border border-border rounded-lg shadow-lg p-3 max-w-xs text-xs"
              style={{ left: tooltip.x + 12, top: tooltip.y - 8 }}
            >
              <div className="flex items-center gap-2 mb-1">
                <MemoryTypeBadge type={tooltip.node.type} />
                <span className="font-medium text-foreground truncate">
                  {tooltip.node.label}
                </span>
              </div>
              {tooltip.node.tags?.length > 0 && (
                <div className="text-muted-foreground mb-1">
                  {tooltip.node.tags
                    .slice(0, 4)
                    .map((t) => `#${t}`)
                    .join(" ")}
                </div>
              )}
              <div className="text-foreground/80 leading-relaxed line-clamp-3">
                {tooltip.node.content}
              </div>
              <div className="mt-1.5 text-muted-foreground">
                Importance: {(tooltip.node.importance * 100).toFixed(0)}%
              </div>
            </div>
          )}

          {/* Minimap */}
          {showMinimap && data && (
            <MinimapOverlay
              nodes={data.nodes}
              graphRef={graphRef}
              nodeColors={NODE_COLORS}
              tick={minimapTick}
            />
          )}

          {/* Focused node info panel */}
          {focusedId && data && (
            <div
              className="absolute bottom-4 left-4 bg-card dark:bg-card rounded-lg p-3 text-xs max-w-56"
              style={{
                border: "1px solid var(--color-accent)",
                boxShadow: "0 0 12px rgba(0,212,200,0.15)",
              }}
            >
              {(() => {
                const n = data.nodes.find((n) => n.id === focusedId);
                return n ? (
                  <>
                    <div
                      className="font-medium mb-1 truncate"
                      style={{ color: "var(--color-accent)" }}
                    >
                      {n.label}
                    </div>
                    <div className="text-muted-foreground">
                      {focusedNeighbors.size - 1} direct connections
                    </div>
                    {activatedIds.size > 0 && (
                      <div className="text-yellow-600 mt-1">
                        ⚡ {activatedIds.size} activated nodes
                      </div>
                    )}
                  </>
                ) : null;
              })()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
