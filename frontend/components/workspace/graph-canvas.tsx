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
  type Viewport,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Box, Braces, ChevronDown, ChevronRight, CircleHelp, FileCode, FlaskConical, Folder, Package, Route, SquareFunction } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
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
  test: "var(--k-test)",
  unresolved: "var(--k-unresolved)",
};

const KIND_ICON: Record<string, typeof FileCode> = {
  file: FileCode,
  module: Folder,
  class: Box,
  interface: Box,
  enum: Box,
  function: SquareFunction,
  method: Braces,
  route: Route,
  package: Package,
  test: FlaskConical,
  unresolved: CircleHelp,
};

export const EDGE_STYLE: Record<string, { stroke: string; dash?: string; label: string }> = {
  resolved: { stroke: "var(--support)", label: "resolved" },
  ambiguous: { stroke: "var(--warn)", dash: "5 4", label: "ambiguous" },
  external: { stroke: "var(--k-package)", dash: "8 5", label: "external" },
  unresolved: { stroke: "var(--bad)", dash: "2 4", label: "unresolved" },
};

const NODE_W = 196;
const NODE_H = 46;
const GROUP_PAD = 14;
const GROUP_HEADER = 26;

/** A visual kind: tests read differently from production code even when their AST kind is "function". */
export function visualKind(n: Pick<ViewNode, "kind" | "path">): string {
  if ((n.kind === "file" || n.kind === "function" || n.kind === "method" || n.kind === "class") && n.path && /(^|\/)(tests?|__tests__|spec)(\/|$)|(^|\/)test_[^/]*$|_test\.(go|py)$|\.(test|spec)\.[jt]sx?$/.test(n.path)) {
    return "test";
  }
  return n.kind;
}

interface NodeData extends Record<string, unknown> {
  node: ViewNode;
  vkind: string;
  state: "selected" | "related" | "dim" | "idle";
  match: boolean;
}

interface GroupData extends Record<string, unknown> {
  dir: string;
  count: number;
  collapsed: boolean;
  dim: boolean;
  onToggle: (dir: string) => void;
}

const AtlasNode = memo(function AtlasNode({ data }: NodeProps<Node<NodeData>>) {
  const n = data.node;
  const color = KIND_VAR[data.vkind] ?? "var(--fg-3)";
  const Icon = KIND_ICON[data.vkind] ?? CircleHelp;
  const label = n.kind === "file" ? n.label.split("/").pop() : n.kind === "module" ? n.label.split("/").slice(-2).join("/") : n.label;
  const sub = n.key.startsWith("group:") ? `${n.files ?? 0} inside · double-click to expand` : n.kind === "module" ? `${n.files ?? 0} files` : n.kind === "file" ? n.label.split("/").slice(0, -1).slice(-2).join("/") : n.path ? n.path.split("/").pop() : "";
  return (
    <div
      className={cn(
        "atlas-node relative flex h-[46px] w-[196px] items-center gap-2.5 overflow-hidden border bg-panel pr-2.5 pl-2 text-left transition-[opacity,border-color,box-shadow] duration-200",
        n.kind === "route" ? "rounded-full pl-3" : "rounded-lg",
        n.kind === "package" && "border-dashed",
        data.state === "selected" ? "border-accent shadow-[0_0_0_3px_var(--accent-soft)]" : data.state === "related" ? "border-[var(--accent-line)]" : n.focus ? "border-accent/60" : "border-line",
        data.state === "dim" && "opacity-[0.22]",
      )}
      title={`${n.kind}: ${n.label}${n.path ? `\n${n.path}` : ""}`}
      data-kind={data.vkind}
      data-state={data.state}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}>
        <Icon className="h-3.5 w-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[9px] tracking-[0.12em] uppercase" style={{ color }}>{data.vkind === "module" ? "dir" : data.vkind}</span>
          {n.is_route_handler && <span className="font-mono text-[9px] tracking-[0.1em] text-[var(--k-route)] uppercase">· handler</span>}
          {data.match && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent" aria-label="matches search" />}
        </div>
        <div className={cn("truncate font-mono text-[12px]", data.state === "selected" ? "text-accent" : "text-fg")}>{label}</div>
        {sub && <div className="truncate font-mono text-[9.5px] text-fg-3">{sub}</div>}
      </div>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
    </div>
  );
});

const GroupNode = memo(function GroupNode({ data }: NodeProps<Node<GroupData>>) {
  const Chevron = data.collapsed ? ChevronRight : ChevronDown;
  return (
    <div className={cn("h-full w-full rounded-xl border border-dashed border-line bg-[color-mix(in_srgb,var(--support)_4%,transparent)] transition-opacity duration-200", data.dim && "opacity-40")}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          data.onToggle(data.dir);
        }}
        className="nodrag flex h-[26px] max-w-full items-center gap-1 px-2 text-left hover:text-accent"
        aria-expanded={!data.collapsed}
        title={data.collapsed ? `Expand ${data.dir}` : `Collapse ${data.dir}`}
      >
        <Chevron className="h-3 w-3 shrink-0 text-fg-3" aria-hidden />
        <Folder className="h-3 w-3 shrink-0 text-[var(--k-module)]" aria-hidden />
        <span className="truncate font-mono text-[10.5px] tracking-[0.06em] text-fg-2">{data.dir}/</span>
        <span className="shrink-0 font-mono text-[10px] text-fg-3">{data.count}</span>
      </button>
    </div>
  );
});

const nodeTypes = { atlas: AtlasNode, group: GroupNode };
// Never fit below a legible zoom: large graphs are panned (minimap, controls) rather than shrunk to dots.
const FIT = { padding: 0.15, maxZoom: 1.1, minZoom: 0.55 };

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function dirOf(n: ViewNode): string | null {
  if (!n.path || n.kind === "module" || n.kind === "package" || n.kind === "route" || n.kind === "unresolved") return null;
  const parts = n.path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
}

interface Laid {
  nodes: Node[];
  edges: ViewEdge[];
}

/** Collapsed groups become one node; edges are re-pointed to it and merged. */
function collapse(nodes: ViewNode[], edges: ViewEdge[], groups: Map<string, string>, collapsed: Set<string>): { nodes: ViewNode[]; edges: ViewEdge[]; members: Map<string, string[]> } {
  const rep = new Map<string, string>();
  const members = new Map<string, string[]>();
  const out: ViewNode[] = [];
  for (const n of nodes) {
    const g = groups.get(n.key);
    if (g && collapsed.has(g)) {
      const gk = `group:${g}`;
      rep.set(n.key, gk);
      if (!members.has(gk)) {
        members.set(gk, []);
        out.push({ key: gk, kind: "module", label: g, path: g, start_line: null, end_line: null, files: 0 });
      }
      members.get(gk)!.push(n.key);
    } else out.push(n);
  }
  for (const m of out) if (members.has(m.key)) m.files = members.get(m.key)!.length;
  const merged = new Map<string, ViewEdge>();
  for (const e of edges) {
    const s = rep.get(e.source) ?? e.source;
    const t = rep.get(e.target) ?? e.target;
    if (s === t) continue;
    const k = `${s}>${t}:${e.kind}`;
    const prev = merged.get(k);
    if (prev) prev.count += e.count;
    else merged.set(k, { ...e, source: s, target: t });
  }
  return { nodes: out, edges: [...merged.values()], members };
}

async function elkLayout(nodes: ViewNode[], edges: ViewEdge[], groups: Map<string, string> | null, direction: "LR" | "TB" | "RL"): Promise<Laid> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const dir = direction === "TB" ? "DOWN" : direction === "RL" ? "LEFT" : "RIGHT";
  const leaf = (n: ViewNode) => ({ id: n.key, width: NODE_W, height: NODE_H });
  const byGroup = new Map<string, ViewNode[]>();
  const top: ViewNode[] = [];
  for (const n of nodes) {
    const g = groups?.get(n.key);
    if (g) {
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(n);
    } else top.push(n);
  }
  const children = [
    ...top.map(leaf),
    ...[...byGroup.entries()].map(([g, ns]) => ({
      id: `groupbox:${g}`,
      layoutOptions: { "elk.padding": `[top=${GROUP_HEADER + 6},left=${GROUP_PAD},bottom=${GROUP_PAD},right=${GROUP_PAD}]` },
      children: ns.map(leaf),
    })),
  ];
  const keys = new Set(nodes.map((n) => n.key));
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": dir,
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.spacing.nodeNode": "16",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.spacing.componentComponent": "36",
    },
    children,
    edges: edges.filter((e) => e.source !== e.target && keys.has(e.source) && keys.has(e.target)).map((e, i) => ({ id: `e${i}`, sources: [e.source], targets: [e.target] })),
  };
  const res = await elk.layout(graph);
  const out: Node[] = [];
  for (const c of res.children ?? []) {
    if (c.id.startsWith("groupbox:")) {
      const dirName = c.id.slice(9);
      out.push({ id: c.id, type: "group", position: { x: c.x ?? 0, y: c.y ?? 0 }, width: c.width, height: c.height, style: { width: c.width, height: c.height }, data: { dir: dirName }, selectable: false, draggable: false, zIndex: -1 });
      for (const k of c.children ?? []) out.push({ id: k.id, type: "atlas", parentId: c.id, extent: "parent", position: { x: k.x ?? 0, y: k.y ?? 0 }, width: NODE_W, height: NODE_H, data: {} });
    } else {
      out.push({ id: c.id, type: "atlas", position: { x: c.x ?? 0, y: c.y ?? 0 }, width: NODE_W, height: NODE_H, data: {} });
    }
  }
  return { nodes: out, edges };
}

function dagreLayout(nodes: ViewNode[], edges: ViewEdge[], direction: "LR" | "TB" | "RL"): Laid {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 14, ranksep: 56, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.key, { width: NODE_W, height: NODE_H });
  for (const e of edges) if (e.source !== e.target) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return {
    nodes: nodes.map((n) => {
      const p = g.node(n.key);
      return { id: n.key, type: "atlas", position: { x: (p?.x ?? 0) - NODE_W / 2, y: (p?.y ?? 0) - NODE_H / 2 }, width: NODE_W, height: NODE_H, data: {} };
    }),
    edges,
  };
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
  /** Group nodes by directory with collapsible frames (used for file and call graphs). */
  group?: boolean;
  /** Keys matching an in-graph search: marked, and kept bright. */
  highlight?: Set<string> | null;
  /** Remembers the camera for this view across tab switches and reloads (sessionStorage). */
  viewportKey?: string;
  /** Glide the camera to the selection when it changes. */
  followSelection?: boolean;
  /** Pixels covered on the right (a floating detail card); the selection is centred in the remaining area. */
  rightInset?: number;
}

function Canvas({ nodes, edges, selected, onSelect, onOpen, direction = "LR", showCounts, fitKey, group, highlight, viewportKey, followSelection, rightInset = 0 }: GraphCanvasProps) {
  const rf = useReactFlow();
  const groups = useMemo(() => {
    if (!group) return null;
    const m = new Map<string, string>();
    for (const n of nodes) {
      const d = dirOf(n);
      if (d) m.set(n.key, d);
    }
    const distinct = new Set(m.values());
    return distinct.size >= 2 && nodes.length > 8 ? m : null;
  }, [group, nodes]);
  // Progressive disclosure: in large graphs, test directories start collapsed (expand with a click).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    if (!groups || nodes.length <= 40) return new Set();
    return new Set([...new Set(groups.values())].filter((d) => /(^|\/)(tests?|__tests__|spec)(\/|$)/.test(d)));
  });
  const view = useMemo(() => (groups ? collapse(nodes, edges, groups, collapsed) : { nodes, edges, members: new Map<string, string[]>() }), [nodes, edges, groups, collapsed]);
  const byKey = useMemo(() => new Map(view.nodes.map((n) => [n.key, n])), [view.nodes]);
  const layoutKey = `${direction}|${view.nodes.map((n) => n.key).join(",")}|${view.edges.length}`;
  const [laid, setLaid] = useState<{ key: string; laid: Laid } | null>(null);

  useEffect(() => {
    let alive = true;
    const liveGroups = groups ? new Map([...groups].filter(([k]) => byKey.has(k))) : null;
    elkLayout(view.nodes, view.edges, liveGroups, direction)
      .catch(() => dagreLayout(view.nodes, view.edges, direction))
      .then((l) => alive && setLaid({ key: layoutKey, laid: l }));
    return () => {
      alive = false;
    };
    // layoutKey captures the inputs that change the layout
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  const neighbours = useMemo(() => {
    if (!selected) return null;
    const set = new Set([selected]);
    for (const e of view.edges) {
      if (e.source === selected) set.add(e.target);
      if (e.target === selected) set.add(e.source);
    }
    return set;
  }, [selected, view.edges]);

  const toggle = useMemo(
    () => (dir: string) =>
      setCollapsed((prev) => {
        const n = new Set(prev);
        if (n.has(dir)) n.delete(dir);
        else n.add(dir);
        return n;
      }),
    [],
  );

  const rfNodes: Node[] = useMemo(() => {
    const l = laid?.key === layoutKey ? laid.laid : null;
    if (!l) return [];
    return l.nodes.map((ln) => {
      if (ln.type === "group") {
        const dir = (ln.data as { dir: string }).dir;
        const members = [...(groups?.entries() ?? [])].filter(([, g]) => g === dir).length;
        const anyRelated = !neighbours || [...(groups?.entries() ?? [])].some(([k, g]) => g === dir && neighbours.has(k));
        return { ...ln, data: { dir, count: members, collapsed: false, dim: !anyRelated, onToggle: toggle } };
      }
      const n = byKey.get(ln.id)!;
      const isGroupRep = n.key.startsWith("group:");
      const state: NodeData["state"] = !neighbours ? "idle" : n.key === selected ? "selected" : neighbours.has(n.key) ? "related" : "dim";
      return {
        ...ln,
        data: { node: n, vkind: isGroupRep ? "module" : visualKind(n), state: highlight && !highlight.has(n.key) && state === "idle" ? "dim" : state, match: !!highlight?.has(n.key) } satisfies NodeData,
      };
    });
  }, [laid, layoutKey, byKey, neighbours, selected, groups, toggle, highlight]);

  const rfEdges: Edge[] = useMemo(
    () =>
      view.edges.map((e, i) => {
        const st = EDGE_STYLE[e.resolution] ?? EDGE_STYLE.resolved;
        const lit = !!selected && (e.source === selected || e.target === selected);
        const faded = !!neighbours && !lit;
        return {
          id: `${i}:${e.source}>${e.target}:${e.kind}`,
          source: e.source,
          target: e.target,
          label: showCounts && e.count > 1 ? String(e.count) : undefined,
          labelStyle: { fill: "var(--fg-3)", fontSize: 10, fontFamily: "var(--font-mono)" },
          labelBgStyle: { fill: "var(--bg)" },
          zIndex: lit ? 2 : 0,
          style: {
            stroke: lit ? "var(--accent)" : st.stroke,
            strokeDasharray: st.dash,
            strokeWidth: lit ? 1.6 : e.kind === "inherits" ? 1.6 : Math.min(2.4, 0.9 + Math.log2(Math.max(1, e.count)) / 2),
            opacity: faded ? 0.08 : lit ? 1 : 0.55,
            transition: "opacity 200ms, stroke 200ms",
          },
          markerEnd: { type: e.kind === "inherits" ? MarkerType.Arrow : MarkerType.ArrowClosed, color: lit ? "var(--accent)" : st.stroke, width: 13, height: 13 },
        };
      }),
    [view.edges, neighbours, selected, showCounts],
  );

  // Camera: restore the remembered viewport for this view, otherwise fit; later glide to the selection.
  const placedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!rfNodes.length) return;
    const tag = `${fitKey}|${layoutKey}`;
    if (placedFor.current === tag) return;
    // Marked as placed only when the camera actually moves: if this effect re-runs before the timer
    // fires, the cleanup cancels the timer and the next run schedules it again.
    const t = setTimeout(() => {
      placedFor.current = tag;
      let saved: Viewport | null = null;
      try {
        saved = viewportKey ? (JSON.parse(sessionStorage.getItem(`ip.vp.${viewportKey}`) ?? "null") as Viewport | null) : null;
      } catch {
        saved = null;
      }
      const sel = selected ? rf.getInternalNode(selected) : undefined;
      if (saved && Number.isFinite(saved.zoom)) {
        // Return to the remembered camera — unless it would hide the selected node.
        const pane = document.querySelector(".react-flow__renderer")?.getBoundingClientRect();
        const visible =
          !sel ||
          !pane ||
          (() => {
            const x = sel.internals.positionAbsolute.x * saved.zoom + saved.x;
            const y = sel.internals.positionAbsolute.y * saved.zoom + saved.y;
            return x >= 0 && y >= 0 && x + NODE_W * saved.zoom <= pane.width - rightInset && y + NODE_H * saved.zoom <= pane.height;
          })();
        if (visible) {
          void rf.setViewport(saved, { duration: 0 });
          return;
        }
      }
      if (sel) {
        void rf.setCenter(sel.internals.positionAbsolute.x + NODE_W / 2 + rightInset / 2 / 0.9, sel.internals.positionAbsolute.y + NODE_H / 2, { zoom: 0.9, duration: 0 });
        return;
      }
      void rf.fitView({ ...FIT, duration: 0 }).then(() => {
        if (rf.getZoom() > FIT.minZoom + 0.01) return;
        // Too large to show legibly at once: open on the most connected node instead of an empty middle.
        const degree = new Map<string, number>();
        for (const e of view.edges) {
          degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
          degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
        }
        const hub = [...degree.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        const n = hub ? rf.getInternalNode(hub) : undefined;
        if (n) void rf.setCenter(n.internals.positionAbsolute.x + NODE_W / 2, n.internals.positionAbsolute.y + NODE_H / 2, { zoom: 0.8, duration: 0 });
      });
    }, 40);
    return () => clearTimeout(t);
    // view.edges only informs the hub fallback; it changes together with layoutKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfNodes.length, fitKey, layoutKey, rf, viewportKey]);

  useEffect(() => {
    if (!followSelection || !selected || !rfNodes.length || placedFor.current === null) return;
    const n = rf.getInternalNode(selected);
    if (!n) return;
    const zoom = Math.max(rf.getZoom(), 0.85);
    const x = n.internals.positionAbsolute.x + NODE_W / 2 + rightInset / 2 / zoom;
    const y = n.internals.positionAbsolute.y + NODE_H / 2;
    void rf.setCenter(x, y, { zoom, duration: reducedMotion() ? 0 : 380 });
    // rightInset only matters for where the node lands; it should not re-trigger a glide by itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, followSelection, rf, rfNodes.length]);

  if (!rfNodes.length) {
    return (
      <div className="flex h-full items-center justify-center" role="status">
        <span className="atlas-label">laying out {view.nodes.length} nodes…</span>
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, n) => n.type === "atlas" && onSelect(n.id)}
      onNodeDoubleClick={(_, n) => {
        if (n.type !== "atlas") return;
        if (n.id.startsWith("group:")) return toggle(n.id.slice(6)); // expand a collapsed directory
        onOpen?.((n.data as NodeData).node);
      }}
      onPaneClick={() => onSelect(null)}
      onMoveEnd={(_, vp) => {
        if (!viewportKey) return;
        try {
          sessionStorage.setItem(`ip.vp.${viewportKey}`, JSON.stringify(vp));
        } catch {
          /* storage unavailable */
        }
      }}
      zoomOnDoubleClick={!onOpen}
      nodesConnectable={false}
      nodesDraggable
      minZoom={0.05}
      maxZoom={2}
      onlyRenderVisibleElements
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Lines} gap={32} lineWidth={1} color="var(--grid)" />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap
        className="atlas-minimap"
        pannable
        zoomable
        position="bottom-right"
        style={{ width: 140, height: 90 }}
        nodeColor={(n) => (n.type === "group" ? "transparent" : (KIND_VAR[(n.data as NodeData).vkind] ?? "var(--fg-3)"))}
        maskColor="rgba(16,18,24,0.6)"
        maskStrokeColor="var(--accent-line)"
      />
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {kinds.map((k) => {
        const Icon = KIND_ICON[k] ?? CircleHelp;
        return (
          <span key={k} className="inline-flex items-center gap-1 font-mono text-[10px] tracking-[0.1em] uppercase" style={{ color: KIND_VAR[k] ?? "var(--fg-3)" }}>
            <Icon className="h-3 w-3" aria-hidden />
            {k === "module" ? "dir" : k}
          </span>
        );
      })}
      <span className="h-3 w-px bg-line" />
      {Object.values(EDGE_STYLE).map((v) => (
        <span key={v.label} className="inline-flex items-center gap-1 font-mono text-[10px] tracking-[0.1em] text-fg-3 uppercase">
          <svg width="18" height="6" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" stroke={v.stroke} strokeWidth="2" strokeDasharray={v.dash} />
          </svg>
          {v.label}
        </span>
      ))}
    </div>
  );
}
