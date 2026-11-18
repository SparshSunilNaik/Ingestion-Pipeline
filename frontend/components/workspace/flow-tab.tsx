"use client";

import { FileCode, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type EntryPoint, type FlowStep, type ViewEdge, type ViewNode } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { questionFor } from "@/components/workspace/actions";
import { GraphCanvas, KIND_VAR } from "@/components/workspace/graph-canvas";
import { EvidenceChip, keyPath, symbolLabel, useNav } from "@/components/workspace/nav";
import { Badge, Button, EmptyState, ErrorState, ResolutionBadge, Segmented, Spinner, cn } from "@/components/ui";

/** One traced execution context: possible call paths from an entry point (route, main, any function). */
export function FlowTab() {
  const nav = useNav();
  const entryKey = nav.param("entry");
  const eps = useAsync(() => api.entryPoints(nav.snapshotId), [nav.snapshotId]);
  const ep: EntryPoint | null = useMemo(() => {
    if (!entryKey) return null;
    return eps.data?.find((e) => e.start_key === entryKey || e.handler_key === entryKey) ?? { kind: "symbol", label: symbolLabel(entryKey), start_key: entryKey, evidence_id: null, traceable: true };
  }, [eps.data, entryKey]);
  const ready = !!ep && (eps.data !== undefined || !!eps.error);
  const flow = useAsync(() => (ready && ep?.start_key ? api.trace(nav.snapshotId, ep.start_key, ep.line_range) : Promise.resolve(null)), [nav.snapshotId, ready, ep?.start_key, ep?.line_range?.[0] ?? null]);
  const [mode, setMode] = useState<"steps" | "graph">("steps");
  const [hover, setHover] = useState<string | null>(null);
  const { setSelection } = nav;
  useEffect(() => {
    if (ep?.start_key) setSelection({ kind: ep.start_key.startsWith("route:") ? "route" : "symbol", key: ep.start_key, label: ep.label, path: keyPath(ep.start_key), symbolKind: ep.kind === "route" ? "route" : "function" });
  }, [ep?.start_key, ep?.label, ep?.kind, setSelection]);

  const graph = useMemo(() => {
    if (!flow.data) return null;
    const nodes = new Map<string, ViewNode>();
    nodes.set(flow.data.start.key, { ...flow.data.start, focus: true });
    const edges: ViewEdge[] = [];
    for (const st of flow.data.steps) {
      nodes.set(st.to.key, { ...st.to });
      edges.push({ source: st.from, target: st.to.key, kind: st.edge_kind, resolution: st.resolution, count: 1, evidence_id: st.evidence_id });
    }
    return { nodes: [...nodes.values()], edges };
  }, [flow.data]);

  if (!entryKey) {
    return (
      <EmptyState icon={<Workflow className="h-6 w-6" />} title="Choose an entry point">
        Pick a route or program in the explorer&apos;s Entry points section, or use &ldquo;Trace execution&rdquo; on any function.
      </EmptyState>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2">
        <Badge tone={ep?.kind === "route" ? "accent" : "neutral"}>{ep?.kind === "route" ? ep.framework ?? "route" : (ep?.kind ?? "symbol").replace("_", " ")}</Badge>
        <h2 className="min-w-0 truncate font-mono text-[14px] font-semibold">{ep?.label}</h2>
        {ep?.evidence_id && <EvidenceChip id={ep.evidence_id} />}
        <div className="ml-auto flex items-center gap-2">
          {flow.data && (
            <span className="text-[11.5px] text-fg-3">
              {flow.data.steps.length} steps{flow.data.truncated ? " · truncated at the depth/step limit" : ""}
            </span>
          )}
          <Segmented label="Flow display" value={mode} onChange={setMode} options={[{ id: "steps", label: "Steps" }, { id: "graph", label: "Graph" }]} />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => ep && nav.ask(questionFor("trace", { kind: ep.kind === "route" ? "route" : "symbol", key: ep.start_key ?? entryKey, label: ep.label, path: keyPath(entryKey) }), { send: true })}
          >
            Explain this flow
          </Button>
        </div>
      </div>
      {flow.data && <div className="shrink-0 border-b border-line bg-info-soft px-4 py-1.5 text-[11.5px] text-fg-2">{flow.data.semantics}</div>}
      <div className="min-h-0 flex-1 overflow-auto">
        {flow.error ? <div className="p-4"><ErrorState error={flow.error} onRetry={flow.reload} /></div> : null}
        {!flow.data && !flow.error && <div className="p-4"><Spinner label="Tracing possible execution" /></div>}
        {flow.data && flow.data.steps.length === 0 && (
          <EmptyState title="No outgoing calls were resolved from here">
            The entry point exists, but none of its calls could be resolved statically (for example calls on dynamic values or into external packages).
          </EmptyState>
        )}
        {flow.data && flow.data.steps.length > 0 && mode === "steps" && <StepTree steps={flow.data.steps} hover={hover} onHover={setHover} />}
        {flow.data && flow.data.steps.length > 0 && mode === "graph" && graph && (
          <div className="h-full min-h-[400px]" data-testid="flow-graph">
            <GraphCanvas nodes={graph.nodes} edges={graph.edges} selected={hover} onSelect={(k) => k && nav.openSymbol(k)} fitKey={entryKey} />
          </div>
        )}
      </div>
    </div>
  );
}

function StepTree({ steps, hover, onHover }: { steps: FlowStep[]; hover: string | null; onHover: (k: string | null) => void }) {
  const nav = useNav();
  return (
    <ol className="py-1" aria-label="Flow steps">
      {steps.map((st) => (
        <li
          key={st.index}
          onMouseEnter={() => onHover(st.to.key)}
          onMouseLeave={() => onHover(null)}
          className={cn("flex items-center gap-2 border-b border-line/50 py-1 pr-4 text-[12.5px]", hover === st.to.key ? "bg-panel-2" : "hover:bg-panel-2")}
          style={{ paddingLeft: 16 + st.depth * 20 }}
        >
          <span className="w-6 shrink-0 text-right font-mono text-[11px] text-fg-3">{st.index + 1}</span>
          <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: KIND_VAR[st.to.kind] ?? "var(--fg-3)" }} aria-hidden />
          <button
            className="min-w-0 truncate text-left font-mono text-[12px] hover:text-accent"
            onClick={() => (st.to.path ? nav.openSource({ path: st.to.path, start: st.to.start_line, end: st.to.end_line, sym: st.to.key.startsWith("sym:") ? st.to.key : undefined }) : undefined)}
            title={st.to.path ? `Open ${st.to.label} in ${st.to.path}` : st.to.label}
          >
            {st.to.label}
          </button>
          <span className="shrink-0 text-[11px] text-fg-3">
            {st.edge_kind === "handled_by" ? "handled by" : "called"}
            {st.call_line ? ` at line ${st.call_line}` : ""}
          </span>
          <ResolutionBadge resolution={st.resolution} via={st.via} />
          {st.certainty === "possible" && <Badge title="One of several possible targets (dynamic dispatch)">possible</Badge>}
          {st.cycle && <Badge tone="warn">cycle</Badge>}
          {st.leaf_reason && st.leaf_reason !== "cycle" && <Badge tone={st.leaf_reason === "depth_limit" ? "warn" : "neutral"}>{st.leaf_reason.replaceAll("_", " ")}</Badge>}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {st.evidence_id && <EvidenceChip id={st.evidence_id} />}
            {st.to.path && <FileCode className="h-3 w-3 text-fg-3" aria-hidden />}
          </span>
        </li>
      ))}
    </ol>
  );
}
