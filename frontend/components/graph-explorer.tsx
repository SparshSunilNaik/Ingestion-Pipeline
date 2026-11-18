"use client";

import dagre from "@dagrejs/dagre";
import { Background, Controls, MarkerType, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, useState } from "react";
import { api, type Graph, type GraphNode } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { Badge, Button, Empty, ErrorBox, Spinner } from "@/components/ui";
import type { OpenEvidence } from "@/components/report-view";

const KIND_COLOR: Record<string, string> = {
  file: "#2f5bd3",
  package: "#8a63d2",
  route: "#1f8a4c",
  class: "#c06a00",
  function: "#0f7d8c",
  method: "#4f7a28",
  unresolved: "#c2362f",
};
const RES_STYLE: Record<string, { stroke: string; dash?: string }> = {
  resolved: { stroke: "#7d8794" },
  external: { stroke: "#8a63d2", dash: "6 4" },
  ambiguous: { stroke: "#c06a00", dash: "2 3" },
  unresolved: { stroke: "#c2362f", dash: "2 3" },
};

function layout(graph: Graph): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 18, ranksep: 70 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) g.setNode(n.key, { width: Math.min(260, 40 + n.label.length * 6.5), height: 34 });
  for (const e of graph.edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  const nodes: Node[] = graph.nodes.map((n) => {
    const p = g.node(n.key);
    return {
      id: n.key,
      position: { x: (p?.x ?? 0) - (p?.width ?? 0) / 2, y: (p?.y ?? 0) - 17 },
      data: { label: n.label, node: n },
      style: {
        borderLeft: `4px solid ${KIND_COLOR[n.kind] ?? "#7d8794"}`,
        fontSize: 11,
        padding: "6px 8px",
        width: p?.width,
        textAlign: "left",
        overflow: "hidden",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
      },
    };
  });
  const edges: Edge[] = graph.edges.map((e, i) => {
    const st = RES_STYLE[e.resolution] ?? RES_STYLE.resolved;
    return {
      id: `${i}`,
      source: e.source,
      target: e.target,
      data: { edge: e },
      style: { stroke: st.stroke, strokeDasharray: st.dash, strokeWidth: Math.min(3, 1 + Math.log2(e.count)) },
      markerEnd: { type: MarkerType.ArrowClosed, color: st.stroke },
    };
  });
  return { nodes, edges };
}

export function GraphExplorer({ snapshotId, onOpen }: { snapshotId: number; onOpen: OpenEvidence }) {
  const [view, setView] = useState<"files" | "symbols">("files");
  const [prefix, setPrefix] = useState("");
  const [applied, setApplied] = useState("");
  const [unresolved, setUnresolved] = useState(false);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const graph = useAsync(() => api.graph(snapshotId, { view, path_prefix: applied || undefined, include_unresolved: unresolved, limit: 300 }), [snapshotId, view, applied, unresolved]);
  const laid = useMemo(() => (graph.data ? layout(graph.data) : null), [graph.data]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select value={view} onChange={(e) => { setView(e.target.value as "files" | "symbols"); setSelected(null); }} className="rounded-md border border-border bg-surface px-2 py-1.5">
          <option value="files">Files, packages &amp; routes (imports)</option>
          <option value="symbols">Symbols (calls, inheritance, containment)</option>
        </select>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setApplied(prefix.trim()); }}>
          <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="path prefix, e.g. src/" className="w-52 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs" />
          <Button type="submit" variant="secondary">Filter</Button>
        </form>
        <label className="flex items-center gap-1.5 text-muted">
          <input type="checkbox" checked={unresolved} onChange={(e) => setUnresolved(e.target.checked)} /> show unresolved references
        </label>
        {graph.data ? (
          <span className="text-xs text-muted">
            {graph.data.nodes.length} of {graph.data.totals.nodes} nodes · {graph.data.edges.length} edges{graph.data.truncated ? " · truncated to most-connected" : ""}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-3 text-[11px] text-muted">
        {Object.entries(RES_STYLE).map(([k, v]) => (
          <span key={k} className="flex items-center gap-1">
            <svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke={v.stroke} strokeWidth="2" strokeDasharray={v.dash} /></svg>
            {k}
          </span>
        ))}
        {Object.entries(KIND_COLOR).map(([k, c]) => (
          <span key={k} className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: c }} />{k}</span>
        ))}
      </div>
      {graph.error ? <ErrorBox error={graph.error} /> : null}
      <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
        <div className="h-[620px] overflow-hidden rounded-md border border-border">
          {!laid ? (
            <div className="p-4"><Spinner label="Laying out graph" /></div>
          ) : laid.nodes.length === 0 ? (
            <div className="p-4"><Empty>No nodes for this view.</Empty></div>
          ) : (
            <ReactFlow
              nodes={laid.nodes}
              edges={laid.edges}
              fitView
              minZoom={0.05}
              nodesConnectable={false}
              onNodeClick={(_, n) => setSelected((n.data as { node: GraphNode }).node)}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable />
            </ReactFlow>
          )}
        </div>
        <Inspector snapshotId={snapshotId} graph={graph.data} node={selected} onOpen={onOpen} />
      </div>
    </div>
  );
}

function Inspector({ snapshotId, graph, node, onOpen }: { snapshotId: number; graph?: Graph; node: GraphNode | null; onOpen: OpenEvidence }) {
  const [impactKey, setImpactKey] = useState<string | null>(null);
  const impact = useAsync(() => (impactKey ? api.impact(snapshotId, impactKey) : Promise.resolve(null)), [snapshotId, impactKey]);
  if (!node) return <div className="rounded-md border border-border bg-surface p-3 text-sm text-muted">Select a node to inspect its relationships and evidence.</div>;
  const outgoing = graph?.edges.filter((e) => e.source === node.key) ?? [];
  const incoming = graph?.edges.filter((e) => e.target === node.key) ?? [];
  const label = (k: string) => graph?.nodes.find((n) => n.key === k)?.label ?? k;

  const openEdge = async (evidenceId: string | null) => {
    if (!evidenceId) return;
    const ev = await api.evidence(evidenceId);
    onOpen({ path: ev.path, start: ev.start_line, end: ev.end_line, id: ev.id });
  };

  return (
    <div className="max-h-[620px] space-y-3 overflow-auto rounded-md border border-border bg-surface p-3 text-sm">
      <div>
        <div className="flex items-center gap-2"><Badge tone="accent">{node.kind}</Badge><span className="font-medium break-all">{node.label}</span></div>
        <code className="mt-1 block text-[11px] break-all text-muted">{node.key}</code>
      </div>
      <div className="flex flex-wrap gap-2">
        {node.path && node.start_line ? (
          <Button variant="secondary" onClick={() => onOpen({ path: node.path!, start: node.start_line!, end: node.end_line ?? node.start_line! })}>Open source</Button>
        ) : null}
        {node.kind !== "package" && node.kind !== "unresolved" ? (
          <Button variant="secondary" onClick={() => setImpactKey(node.key)}>What depends on this?</Button>
        ) : null}
      </div>
      {impactKey === node.key ? (
        <div className="rounded border border-border p-2">
          <div className="mb-1 text-xs font-semibold">Impact (reverse dependencies)</div>
          {impact.data ? (
            impact.data.dependents.length === 0 ? <Empty>No resolved dependents.</Empty> : (
              <ul className="space-y-0.5 text-xs">
                {impact.data.dependents.slice(0, 60).map((d) => (
                  <li key={d.key}><span className="text-muted">d{d.depth} {d.via} ←</span> <span className="break-all">{d.label ?? d.key}</span></li>
                ))}
              </ul>
            )
          ) : <Spinner />}
          {impact.data ? <p className="mt-1 text-[11px] text-muted">{impact.data.note}</p> : null}
        </div>
      ) : null}
      {[["Outgoing", outgoing, "target"], ["Incoming", incoming, "source"]].map(([title, list, side]) => (
        <div key={title as string}>
          <div className="mb-1 text-xs font-semibold">{title as string} ({(list as typeof outgoing).length})</div>
          <ul className="space-y-1">
            {(list as typeof outgoing).slice(0, 80).map((e, i) => (
              <li key={i} className="flex items-start justify-between gap-2 text-xs">
                <span className="break-all"><span className="text-muted">{e.kind}</span> {label(side === "target" ? e.target : e.source)}</span>
                <span className="flex shrink-0 items-center gap-1">
                  <Badge tone={e.resolution === "resolved" ? "ok" : e.resolution === "external" ? "accent" : e.resolution === "ambiguous" ? "warn" : "bad"}>{e.resolution}</Badge>
                  {e.evidence_id ? <button className="text-accent hover:underline" onClick={() => void openEdge(e.evidence_id)}>evidence</button> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
