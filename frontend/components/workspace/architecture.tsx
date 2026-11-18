"use client";

import { Crosshair, FileCode, ListFilter, Play, Route, Search, Workflow } from "lucide-react";
import { useMemo, useState } from "react";
import { Group, Panel as RPanel, Separator, useDefaultLayout } from "react-resizable-panels";
import { api, type EntryPoint, type FlowStep, type Snapshot, type ViewEdge, type ViewNode } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { Badge, Button, EmptyState, ErrorState, ResolutionBadge, Segmented, SkeletonRows, Spinner, cn } from "@/components/ui";
import { RelatedBlock } from "@/components/workspace/code-explorer";
import { GraphCanvas, GraphLegend, KIND_VAR } from "@/components/workspace/graph-canvas";
import { EvidenceChip, useNav } from "@/components/workspace/nav";

type GView = "modules" | "files" | "calls" | "routes" | "focus" | "flows";
const GVIEWS: { id: GView; label: string; title: string }[] = [
  { id: "modules", label: "Modules", title: "Directories and resolved imports between them" },
  { id: "files", label: "Files", title: "File dependency graph (imports), packages and routes" },
  { id: "calls", label: "Calls", title: "Function / method call graph and inheritance" },
  { id: "routes", label: "API routes", title: "Routes, their handlers and direct callees" },
  { id: "focus", label: "Focus", title: "Neighbourhood of one node" },
  { id: "flows", label: "Flows", title: "Execution-flow tracing from entry points" },
];
const RESOLUTIONS = ["resolved", "ambiguous", "external", "unresolved"] as const;

export function Architecture({ snapshot: s }: { snapshot: Snapshot }) {
  const nav = useNav();
  const gview = (GVIEWS.some((g) => g.id === nav.param("gview")) ? nav.param("gview") : nav.param("focus") ? "focus" : "modules") as GView;
  const focus = nav.param("focus");
  const [radius, setRadius] = useState(1);
  const layout = useDefaultLayout({ id: "ip.arch.layout" });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-1.5">
        <Segmented label="Graph view" value={gview} onChange={(v) => nav.setParams({ gview: v })} options={GVIEWS.map((g) => ({ id: g.id, label: g.label, title: g.title }))} />
        {gview === "focus" && (
          <Segmented label="Radius" value={String(radius)} onChange={(v) => setRadius(Number(v))} options={[{ id: "1", label: "1 hop" }, { id: "2", label: "2 hops" }, { id: "3", label: "3 hops" }]} />
        )}
        <FocusSearch snapshotId={s.id} />
      </div>
      {gview === "flows" ? (
        <Flows snapshot={s} />
      ) : (
        <Group orientation="horizontal" id="ip.arch.layout" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged} className="min-h-0 flex-1">
          <RPanel id="graph" defaultSize="70" minSize="40" className="flex min-h-0 flex-col">
            <GraphPane snapshot={s} view={gview} focus={focus} radius={radius} />
          </RPanel>
          <Separator />
          <RPanel id="inspector" defaultSize="30" minSize="20" className="flex min-h-0 flex-col bg-panel">
            <Inspector snapshot={s} />
          </RPanel>
        </Group>
      )}
    </div>
  );
}

function FocusSearch({ snapshotId }: { snapshotId: number }) {
  const nav = useNav();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [miss, setMiss] = useState(false);
  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (q.trim().length < 2) return;
    setBusy(true);
    setMiss(false);
    try {
      const r = await api.retrieve(snapshotId, q.trim(), 5);
      const hit = r.results.find((x) => x.kind === "symbol") ?? r.results.find((x) => x.kind === "file");
      if (hit) nav.setParams({ gview: "focus", focus: hit.key, node: hit.key });
      else setMiss(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={go} className="ml-auto flex items-center gap-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find & focus symbol or file" aria-label="Find and focus a node" className={cn("h-7 w-60 rounded-md border bg-panel-2 pr-2 pl-7 text-[12px] outline-none focus:border-accent", miss ? "border-bad/60" : "border-line")} />
      </div>
      <Button size="sm" type="submit" disabled={busy}><Crosshair className="h-3.5 w-3.5" /> Focus</Button>
    </form>
  );
}

function GraphPane({ snapshot: s, view, focus, radius }: { snapshot: Snapshot; view: GView; focus: string | null; radius: number }) {
  const nav = useNav();
  const selected = nav.param("node");
  const graph = useAsync(
    () => (view === "focus" && !focus ? Promise.resolve(null) : api.graphView(s.id, { view, focus: view === "focus" ? focus ?? undefined : undefined, radius, limit: view === "modules" ? 120 : 220 })),
    [s.id, view, focus, radius],
  );
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [hiddenRes, setHiddenRes] = useState<Set<string>>(new Set());
  const [hideIsolated, setHideIsolated] = useState(true);
  const data = graph.data;
  const edgeKinds = useMemo(() => [...new Set((data?.edges ?? []).map((e) => e.kind))].sort(), [data]);
  const nodeKinds = useMemo(() => [...new Set((data?.nodes ?? []).map((n) => n.kind))].sort(), [data]);
  const edges = useMemo(() => (data?.edges ?? []).filter((e) => !hiddenKinds.has(e.kind) && !hiddenRes.has(e.resolution)), [data, hiddenKinds, hiddenRes]);
  const nodes = useMemo(() => {
    const all = data?.nodes ?? [];
    if (!hideIsolated || view === "focus") return all;
    const connected = new Set(edges.flatMap((e) => [e.source, e.target]));
    return all.filter((n) => connected.has(n.key) || n.focus);
  }, [data, edges, hideIsolated, view]);
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, v: string) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    setter(n);
  };

  if (view === "focus" && !focus) return <EmptyState icon={<Crosshair className="h-6 w-6" />} title="Nothing focused">Use “Find & focus”, or choose “Impact” / “Usage” from any symbol.</EmptyState>;
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5">
        <span className="inline-flex items-center gap-1 text-[11.5px] text-fg-3"><ListFilter className="h-3.5 w-3.5" /> edges</span>
        {edgeKinds.map((k) => (
          <label key={k} className="inline-flex cursor-pointer items-center gap-1 text-[12px] text-fg-2">
            <input type="checkbox" checked={!hiddenKinds.has(k)} onChange={() => toggle(hiddenKinds, setHiddenKinds, k)} className="accent-[var(--accent)]" />
            {k.replaceAll("_", " ")}
          </label>
        ))}
        <span className="h-3 w-px bg-line" />
        {RESOLUTIONS.map((r) => (
          <label key={r} className="inline-flex cursor-pointer items-center gap-1 text-[12px] text-fg-2">
            <input type="checkbox" checked={!hiddenRes.has(r)} onChange={() => toggle(hiddenRes, setHiddenRes, r)} className="accent-[var(--accent)]" />
            {r}
          </label>
        ))}
        <span className="h-3 w-px bg-line" />
        <label className="inline-flex cursor-pointer items-center gap-1 text-[12px] text-fg-2" title="Hide nodes without any visible relationship">
          <input type="checkbox" checked={hideIsolated} onChange={() => setHideIsolated(!hideIsolated)} className="accent-[var(--accent)]" />
          hide isolated
        </label>
        {data && <span className="ml-auto text-[11.5px] text-fg-3">{nodes.length} of {data.nodes.length} nodes · {edges.length} edges{data.truncated ? " · limited to most-connected" : ""}</span>}
      </div>
      <div className="relative min-h-0 flex-1" data-testid="graph-canvas">
        {graph.error ? <div className="p-3"><ErrorState error={graph.error} onRetry={graph.reload} /></div> : null}
        {!data && !graph.error && <div className="p-4"><Spinner label="Building graph" /></div>}
        {data && data.nodes.length === 0 && <EmptyState title="No nodes in this view" />}
        {data && data.nodes.length > 0 && nodes.length === 0 && <EmptyState title="All nodes are isolated with the current filters" />}
        {data && nodes.length > 0 && (
          <GraphCanvas nodes={nodes} edges={edges} selected={selected} onSelect={(k) => nav.setParams({ node: k })} showCounts={view === "modules"} fitKey={`${view}:${focus}:${radius}`} />
        )}
        <div className="pointer-events-none absolute top-2 left-2 rounded-md border border-line bg-panel/90 px-2 py-1">
          <GraphLegend kinds={nodeKinds} />
        </div>
      </div>
    </>
  );
}

function Inspector({ snapshot: s }: { snapshot: Snapshot }) {
  const nav = useNav();
  const key = nav.param("node") ?? nav.param("focus");
  const tab = (nav.param("tab") as "relations" | "usage" | "impact" | null) ?? "relations";
  if (!key) return <EmptyState icon={<Crosshair className="h-5 w-5" />} title="Select a node">Click any node to inspect its relationships, usage and potential impact.</EmptyState>;
  const kind = key.startsWith("sym:") ? "symbol" : key.startsWith("file:") ? "file" : key.startsWith("route:") ? "route" : key.split(":")[0];
  const label = key.startsWith("sym:") ? key.split("#")[1] : key.replace(/^[a-z]+:/, "");
  const path = key.startsWith("sym:") ? key.slice(4).split("#")[0] : key.startsWith("file:") ? key.slice(5) : null;
  const symbolLike = kind === "symbol" || kind === "file" || kind === "route";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line p-3">
        <div className="flex items-center gap-1.5">
          <Badge tone="accent">{kind}</Badge>
          {path && <button className="ml-auto text-[11.5px] text-accent hover:underline" onClick={() => nav.openSource({ path })}><FileCode className="mr-1 inline h-3 w-3" />source</button>}
        </div>
        <div className="mt-1 font-mono text-[12.5px] break-all">{label}</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => nav.setParams({ gview: "focus", focus: key })}><Crosshair className="h-3.5 w-3.5" /> Focus</Button>
          {(kind === "symbol" || kind === "route") && <Button size="sm" variant="ghost" onClick={() => nav.setParams({ gview: "flows", entry: key })}><Play className="h-3.5 w-3.5" /> Trace</Button>}
        </div>
      </div>
      {symbolLike && (
        <div className="shrink-0 border-b border-line px-3 py-1.5">
          <Segmented label="Inspector tab" value={tab} onChange={(v) => nav.setParams({ tab: v })} options={[{ id: "relations", label: "Usage" }, { id: "impact", label: "Impact" }]} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3 text-[12.5px]">
        {tab === "impact" ? <ImpactPanel snapshotId={s.id} nodeKey={key} /> : <UsagePanel snapshotId={s.id} nodeKey={key} />}
      </div>
    </div>
  );
}

function UsagePanel({ snapshotId, nodeKey }: { snapshotId: number; nodeKey: string }) {
  const nav = useNav();
  const u = useAsync(() => api.usage(snapshotId, nodeKey), [snapshotId, nodeKey]);
  if (u.error) return <ErrorState error={u.error} compact />;
  if (!u.data) return <SkeletonRows rows={6} />;
  const d = u.data;
  const open = (r: { path: string | null; start_line: number | null; end_line: number | null; call_line?: number | null }) => r.path && nav.openSource({ path: r.path, start: r.call_line ?? r.start_line, end: r.call_line ?? r.end_line });
  return (
    <div className="space-y-3">
      {d.definition.evidence_id && <div className="flex items-center gap-2"><span className="text-fg-3">Definition</span><EvidenceChip id={d.definition.evidence_id} /></div>}
      <RelatedBlock title="Direct references" items={d.direct_references.map((r) => ({ key: r.key + r.call_line, label: r.label, sub: r.relation, resolution: r.resolution, via: r.via, ev: r.evidence_id, onClick: () => open(r) }))} />
      <RelatedBlock title="Importing files" items={d.importing_files.map((r) => ({ key: r.key, label: r.label, resolution: r.resolution, ev: r.evidence_id, onClick: () => open(r) }))} />
      <RelatedBlock title="Direct callees" items={d.direct_callees.map((r) => ({ key: r.key, label: r.label, resolution: r.resolution, via: r.via, ev: r.evidence_id, onClick: () => nav.setParams({ node: r.key }) }))} />
      <RelatedBlock title="Related API routes" items={d.related_routes.map((r) => ({ key: r.key, label: r.label, sub: `depth ${r.depth}`, onClick: () => nav.setParams({ node: r.key }) }))} />
      <RelatedBlock title="Upstream dependents (transitive)" hint="Reachability, depth > 1" items={d.upstream_transitive.slice(0, 25).map((r) => ({ key: r.key, label: r.label, sub: `depth ${r.depth}`, onClick: () => nav.setParams({ node: r.key }) }))} />
      <RelatedBlock title="Downstream dependencies (transitive)" items={d.downstream_transitive.slice(0, 25).map((r) => ({ key: r.key, label: r.label, sub: `depth ${r.depth}`, onClick: () => nav.setParams({ node: r.key }) }))} />
      <ul className="space-y-1 border-t border-line pt-2 text-[11.5px] text-fg-3">{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </div>
  );
}

function ImpactPanel({ snapshotId, nodeKey }: { snapshotId: number; nodeKey: string }) {
  const nav = useNav();
  const im = useAsync(() => api.impact(snapshotId, nodeKey), [snapshotId, nodeKey]);
  if (im.error) return <ErrorState error={im.error} compact />;
  if (!im.data) return <SkeletonRows rows={6} />;
  const d = im.data;
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-warn/30 bg-warn-soft px-2 py-1.5 text-[12px] text-warn">Potential impact from static reachability — not guaranteed breakage.</div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat n={d.direct_dependents.length} label="direct" />
        <Stat n={d.transitive_dependents.length} label="transitive" />
        <Stat n={d.potentially_affected_routes.length} label="routes" />
      </div>
      <RelatedBlock title="Direct dependents" items={d.direct_dependents.map((r) => ({ key: r.key, label: r.label, sub: r.via, resolution: r.resolution, ev: r.evidence_id, onClick: () => nav.setParams({ node: r.key }) }))} />
      <RelatedBlock title="Transitive dependents" items={d.transitive_dependents.slice(0, 40).map((r) => ({ key: r.key, label: r.label, sub: `depth ${r.depth} · ${r.via}`, onClick: () => nav.setParams({ node: r.key }) }))} />
      <RelatedBlock title="Potentially affected routes" items={d.potentially_affected_routes.map((r) => ({ key: r.key, label: r.label, onClick: () => nav.setParams({ node: r.key }) }))} />
      <RelatedBlock title="Related tests" items={d.related_tests.map((t) => ({ key: t, label: t, onClick: () => nav.openSource({ path: t }) }))} />
      {d.unresolved_references.length > 0 && <RelatedBlock title="Unresolved same-name references" hint="Not proven to target this node" items={d.unresolved_references.map((r) => ({ key: r.key + r.evidence_id, label: r.label, sub: r.path ?? "", resolution: "unresolved", ev: r.evidence_id }))} />}
      <ul className="space-y-1 border-t border-line pt-2 text-[11.5px] text-fg-3">{d.limitations.map((n) => <li key={n}>{n}</li>)}</ul>
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="rounded-md border border-line bg-panel-2 py-1.5">
      <div className="font-mono text-[16px] font-semibold">{n}</div>
      <div className="text-[10.5px] text-fg-3 uppercase">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------- execution flows
function Flows({ snapshot: s }: { snapshot: Snapshot }) {
  const nav = useNav();
  const eps = useAsync(() => api.entryPoints(s.id), [s.id]);
  const entryKey = nav.param("entry");
  const ep: EntryPoint | null = useMemo(() => {
    if (!entryKey) return null;
    return eps.data?.find((e) => e.start_key === entryKey) ?? { kind: "symbol", label: entryKey.split("#").pop() ?? entryKey, start_key: entryKey, evidence_id: null, traceable: true };
  }, [eps.data, entryKey]);
  const flow = useAsync(() => (ep?.start_key ? api.trace(s.id, ep.start_key, ep.line_range) : Promise.resolve(null)), [s.id, ep?.start_key, ep?.line_range?.[0] ?? null]);
  const [mode, setMode] = useState<"steps" | "graph">("steps");
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

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-3 text-[11.5px] font-semibold tracking-wide text-fg-2 uppercase"><Route className="h-3.5 w-3.5" /> Entry points</div>
        <ul className="min-h-0 flex-1 overflow-auto py-1">
          {!eps.data && <li className="p-3"><SkeletonRows rows={5} /></li>}
          {eps.data?.length === 0 && <li className="px-3 py-2 text-[12px] text-fg-3">No traceable entry points detected.</li>}
          {(eps.data ?? []).map((e) => (
            <li key={`${e.kind}:${e.label}`}>
              <button
                disabled={!e.traceable}
                onClick={() => e.start_key && nav.setParams({ entry: e.start_key })}
                className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] disabled:opacity-40", entryKey === e.start_key ? "bg-accent-soft text-accent" : "hover:bg-panel-3")}
              >
                <Badge tone={e.kind === "route" ? "accent" : "neutral"}>{e.kind === "route" ? e.framework ?? "route" : e.kind.replace("_", " ")}</Badge>
                <span className="min-w-0 truncate font-mono text-[12px]">{e.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {!ep ? (
          <EmptyState icon={<Workflow className="h-6 w-6" />} title="Choose an entry point">Traces follow statically resolved call sites, in source order, from a route handler, main function or CLI entry.</EmptyState>
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-1.5">
              <span className="truncate font-mono text-[12.5px]">{ep.label}</span>
              {ep.evidence_id && <EvidenceChip id={ep.evidence_id} />}
              <div className="ml-auto flex items-center gap-2">
                {flow.data && (
                  <span className="text-[11.5px] text-fg-3">
                    {flow.data.steps.length} steps · {Object.entries(flow.data.stats).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(" · ")}
                    {flow.data.truncated ? " · truncated" : ""}
                  </span>
                )}
                <Segmented label="Flow display" value={mode} onChange={setMode} options={[{ id: "steps", label: "Steps" }, { id: "graph", label: "Graph" }]} />
              </div>
            </div>
            {flow.data && <div className="shrink-0 border-b border-line bg-info-soft/30 px-3 py-1.5 text-[11.5px] text-fg-2">{flow.data.semantics}</div>}
            <div className="min-h-0 flex-1 overflow-auto">
              {flow.error ? <div className="p-3"><ErrorState error={flow.error} onRetry={flow.reload} /></div> : null}
              {!flow.data && !flow.error && <div className="p-4"><Spinner label="Tracing" /></div>}
              {flow.data && mode === "steps" && <StepTree steps={flow.data.steps} />}
              {flow.data && mode === "graph" && graph && <div className="h-full"><GraphCanvas nodes={graph.nodes} edges={graph.edges} selected={null} onSelect={(k) => k && nav.setParams({ gview: "focus", focus: k, node: k })} fitKey={ep.start_key ?? ""} /></div>}
              {flow.data && flow.data.steps.length === 0 && <EmptyState title="No outgoing calls were resolved from this entry point" />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StepTree({ steps }: { steps: FlowStep[] }) {
  const nav = useNav();
  return (
    <ol className="py-1" aria-label="Flow steps">
      {steps.map((st) => (
        <li key={st.index} className="flex items-center gap-2 border-b border-line/50 py-1 pr-3 text-[12.5px] hover:bg-panel-2" style={{ paddingLeft: 12 + st.depth * 18 }}>
          <span className="w-6 shrink-0 text-right font-mono text-[11px] text-fg-3">{st.index + 1}</span>
          <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: KIND_VAR[st.to.kind] ?? "var(--fg-3)" }} aria-hidden />
          <button className="min-w-0 truncate text-left font-mono text-[12px] hover:text-accent" onClick={() => st.to.path ? nav.openSource({ path: st.to.path, start: st.to.start_line, end: st.to.end_line }) : undefined} title={st.to.key}>
            {st.to.label}
          </button>
          <span className="shrink-0 text-[11px] text-fg-3">{st.edge_kind === "handled_by" ? "handled by" : "calls"}{st.call_line ? ` @${st.call_line}` : ""}</span>
          <ResolutionBadge resolution={st.resolution} via={st.via} />
          {st.certainty === "possible" && <Badge title="Static possible path, not observed runtime order">possible</Badge>}
          {st.cycle && <Badge tone="warn">cycle</Badge>}
          {st.leaf_reason && st.leaf_reason !== "cycle" && <Badge tone={st.leaf_reason === "depth_limit" ? "warn" : "neutral"}>{st.leaf_reason.replace("_", " ")}</Badge>}
          <span className="ml-auto shrink-0">{st.evidence_id && <EvidenceChip id={st.evidence_id} />}</span>
        </li>
      ))}
    </ol>
  );
}
