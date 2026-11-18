"use client";

import dagre from "@dagrejs/dagre";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  type Edge,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo } from "react";
import type { ViewEdge, ViewNode } from "@/lib/api";
import { cn } from "@/components/ui";

export const KIND_VAR: Record<string, string> = {
  file: "var(--k-file)",
  module: "var(--k-module)",
  class: "var(--k-class)",
  interface: "var(--k-class)",
  enum: "var(--k-class)",
  function: "var(--k-function)",
  method: "var(--k-method)",
  route: "var(--k-route)",
  package: "var(--k-package)",
  unresolved: "var(--k-unresolved)",
};

export const EDGE_STYLE: Record<string, { stroke: string; dash?: string }> = {
  resolved: { stroke: "var(--fg-3)" },
  ambiguous: { stroke: "var(--warn)", dash: "5 4" },
  external: { stroke: "var(--k-package)", dash: "8 5" },
  unresolved: { stroke: "var(--bad)", dash: "2 4" },
};

interface NodeData extends Record<string, unknown> {
  node: ViewNode;
  dim: boolean;
  selected: boolean;
}

function IpNode({ data }: NodeProps<Node<NodeData>>) {
  const n = data.node;
  const color = KIND_VAR[n.kind] ?? "var(--fg-3)";
  const label = n.kind === "file" ? n.label.split("/").slice(-2).join("/") : n.label;
  return (
    <div
      className={cn(
        "flex h-[38px] w-[184px] items-center gap-2 overflow-hidden rounded-md border bg-panel pr-2 text-left shadow-sm transition-opacity",
        data.selected ? "border-accent" : n.focus ? "border-accent/70" : "border-line-strong",
        data.dim && "opacity-25",
      )}
      title={`${n.kind}: ${n.label}${n.path ? `\n${n.path}` : ""}`}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
      <span className="h-full w-[4px] shrink-0" style={{ background: color }} />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex items-center gap-1">
          <span className="text-[9.5px] tracking-wider uppercase" style={{ color }}>{n.kind === "module" ? "dir" : n.kind}</span>
          {n.is_route_handler && <span className="rounded bg-[var(--k-route)]/15 px-1 text-[9px] text-[var(--k-route)]">handler</span>}
          {n.kind === "module" && <span className="text-[9.5px] text-fg-3">{n.files} files</span>}
        </div>
        <div className="truncate font-mono text-[11.5px] text-fg">{label}</div>
      </div>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
    </div>
  );
}

const nodeTypes = { ip: IpNode };

function layout(nodes: ViewNode[], edges: ViewEdge[], direction: "LR" | "TB" | "RL") {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 12, ranksep: 48, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.key, { width: 184, height: 38 });
  for (const e of edges) if (e.source !== e.target) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return new Map(nodes.map((n) => {
    const p = g.node(n.key);
    return [n.key, { x: (p?.x ?? 0) - 92, y: (p?.y ?? 0) - 19 }];
  }));
}

export interface GraphCanvasProps {
  nodes: ViewNode[];
  edges: ViewEdge[];
  selected: string | null;
  onSelect: (key: string | null) => void;
  /** Double-click: open the node (drill into a directory, open a file or symbol). */
  onOpen?: (node: ViewNode) => void;
  direction?: "LR" | "TB" | "RL";
  showCounts?: boolean;
  fitKey?: string;
}

function Canvas({ nodes, edges, selected, onSelect, onOpen, direction = "LR", showCounts, fitKey }: GraphCanvasProps) {
  const rf = useReactFlow();
  const positions = useMemo(() => layout(nodes, edges, direction), [nodes, edges, direction]);
  const neighbours = useMemo(() => {
    if (!selected) return null;
    const set = new Set([selected]);
    for (const e of edges) {
      if (e.source === selected) set.add(e.target);
      if (e.target === selected) set.add(e.source);
    }
    return set;
  }, [selected, edges]);

  const rfNodes: Node<NodeData>[] = useMemo(
    () => nodes.map((n) => ({ id: n.key, type: "ip", position: positions.get(n.key) ?? { x: 0, y: 0 }, data: { node: n, dim: !!neighbours && !neighbours.has(n.key), selected: n.key === selected } })),
    [nodes, positions, neighbours, selected],
  );
  const rfEdges: Edge[] = useMemo(
    () =>
      edges.map((e, i) => {
        const st = EDGE_STYLE[e.resolution] ?? EDGE_STYLE.resolved;
        const touched = !neighbours || (neighbours.has(e.source) && neighbours.has(e.target) && (e.source === selected || e.target === selected));
        return {
          id: `${i}:${e.source}>${e.target}:${e.kind}`,
          source: e.source,
          target: e.target,
          label: showCounts && e.count > 1 ? String(e.count) : undefined,
          labelStyle: { fill: "var(--fg-3)", fontSize: 10 },
          labelBgStyle: { fill: "var(--bg)" },
          style: {
            stroke: touched && selected ? "var(--accent)" : st.stroke,
            strokeDasharray: st.dash,
            strokeWidth: e.kind === "inherits" ? 2 : Math.min(3, 1 + Math.log2(Math.max(1, e.count)) / 2),
            opacity: touched ? 1 : 0.15,
          },
          markerEnd: { type: e.kind === "inherits" ? MarkerType.Arrow : MarkerType.ArrowClosed, color: touched && selected ? "var(--accent)" : st.stroke, width: 14, height: 14 },
          data: { edge: e },
        };
      }),
    [edges, neighbours, selected, showCounts],
  );

  const initialized = useNodesInitialized();
  useEffect(() => {
    if (!initialized) return;
    // Wait a frame so freshly laid-out nodes are measured before fitting.
    const t = setTimeout(() => void rf.fitView({ padding: 0.15, maxZoom: 1.1, duration: 0 }), 60);
    return () => clearTimeout(t);
  }, [initialized, fitKey, nodes.length, rf]);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, n) => onSelect(n.id)}
      onNodeDoubleClick={(_, n) => onOpen?.((n.data as NodeData).node)}
      zoomOnDoubleClick={!onOpen}
      onPaneClick={() => onSelect(null)}
      nodesConnectable={false}
      nodesDraggable
      minZoom={0.05}
      maxZoom={2}
      onlyRenderVisibleElements
      proOptions={{ hideAttribution: true }}
      fitView
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--line)" />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap pannable zoomable position="bottom-right" style={{ width: 150, height: 96 }} nodeColor={(n) => KIND_VAR[(n.data as NodeData).node.kind] ?? "var(--fg-3)"} maskColor="rgba(0,0,0,0.35)" />
    </ReactFlow>
  );
}

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

export function GraphLegend({ kinds }: { kinds: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-3">
      {Object.entries(EDGE_STYLE).map(([k, v]) => (
        <span key={k} className="inline-flex items-center gap-1">
          <svg width="20" height="6" aria-hidden><line x1="0" y1="3" x2="20" y2="3" stroke={v.stroke} strokeWidth="2" strokeDasharray={v.dash} /></svg>
          {k}
        </span>
      ))}
      <span className="h-3 w-px bg-line" />
      {kinds.map((k) => (
        <span key={k} className="inline-flex items-center gap-1">
          <span className="h-2.5 w-1 rounded-sm" style={{ background: KIND_VAR[k] ?? "var(--fg-3)" }} />
          {k === "module" ? "directory" : k}
        </span>
      ))}
    </div>
  );
}
