"use client";

import { Crosshair, FileCode, FolderTree, ListFilter, Play, Radar, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Group, Panel as RPanel, Separator, useDefaultLayout } from "react-resizable-panels";
import { api, type Snapshot } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { questionFor } from "@/components/workspace/actions";
import { GraphCanvas, GraphLegend } from "@/components/workspace/graph-canvas";
import { EvidenceChip, keyPath, symbolLabel, useNav } from "@/components/workspace/nav";
import { RelatedBlock } from "@/components/workspace/related";
import { Badge, Button, EmptyState, ErrorState, IconButton, Segmented, SkeletonRows, Spinner, cn } from "@/components/ui";

type GView = "modules" | "files" | "calls" | "routes" | "focus";
const GVIEWS: { id: GView; label: string; title: string }[] = [
  { id: "modules", label: "Directories", title: "Directories and the resolved imports between them. Double-click a directory to open its files." },
  { id: "files", label: "Files", title: "Files and their resolved imports" },
  { id: "calls", label: "Calls", title: "Functions and methods: resolved calls and inheritance" },
  { id: "routes", label: "API routes", title: "Routes, their handlers and what the handlers call" },
  { id: "focus", label: "Focus", title: "The neighbourhood of one node" },
];
const RESOLUTIONS = ["resolved", "ambiguous", "external", "unresolved"] as const;

/** Small repositories read better as a file graph; larger ones start from directories. */
export function defaultGraphView(s: Snapshot): GView {
  return (s.inventory_summary.source_directories?.length ?? 0) > 3 || s.coverage.analyzed_files > 60 ? "modules" : "files";
}

export function Architecture({ snapshot: s }: { snapshot: Snapshot }) {
  const nav = useNav();
  const requested = nav.param("gview");
  const gview = (GVIEWS.some((g) => g.id === requested) ? requested : nav.param("focus") ? "focus" : defaultGraphView(s)) as GView;
  const focus = nav.param("focus");
  const prefix = nav.param("prefix");
  const [radius, setRadius] = useState(1);
  const layout = useDefaultLayout({ id: "ip.arch.layout" });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-1.5">
        <Segmented label="Graph view" value={gview} onChange={(v) => nav.setParams({ gview: v, ...(v !== "focus" ? { focus: null } : {}) })} options={GVIEWS.map((g) => ({ id: g.id, label: g.label, title: g.title }))} />
        {gview === "focus" && (
          <Segmented label="Radius" value={String(radius)} onChange={(v) => setRadius(Number(v))} options={[{ id: "1", label: "1 hop" }, { id: "2", label: "2 hops" }, { id: "3", label: "3 hops" }]} />
        )}
        {prefix && gview !== "focus" && (
          <span className="inline-flex h-7 items-center gap-1 rounded-md border border-accent/40 bg-accent-soft px-2 font-mono text-[11.5px] text-accent">
            <FolderTree className="h-3.5 w-3.5" aria-hidden /> {prefix}/
            <button onClick={() => nav.setParams({ prefix: null })} aria-label="Show the whole repository" className="ml-0.5 rounded hover:bg-panel-3"><X className="h-3 w-3" /></button>
          </span>
        )}
        <FocusSearch snapshotId={s.id} />
      </div>
      <Group orientation="horizontal" id="ip.arch.layout" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged} className="min-h-0 flex-1">
        <RPanel id="graph" defaultSize="70" minSize="40" className="flex min-h-0 flex-col">
          <GraphPane snapshot={s} view={gview} focus={focus} radius={radius} prefix={prefix} />
        </RPanel>
        {(nav.param("node") || focus) && (
          <>
            <Separator aria-label="Resize graph inspector" />
            <RPanel id="inspector" defaultSize="32" minSize="22" className="flex min-h-0 flex-col bg-panel">
              <Inspector snapshot={s} />
            </RPanel>
          </>
        )}
      </Group>
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
      if (hit) nav.setParams({ gview: "focus", focus: hit.key, node: hit.key, prefix: null });
      else setMiss(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={go} className="ml-auto flex items-center gap-1.5" role="search">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setMiss(false); }}
          placeholder="Find a symbol or file to focus"
          aria-label="Find and focus a node"
          aria-invalid={miss || undefined}
          className={cn("h-7 w-60 rounded-md border bg-panel-2 pr-2 pl-7 text-[12px] outline-none focus:border-accent", miss ? "border-bad/60" : "border-line")}
        />
      </div>
      <Button size="sm" type="submit" disabled={busy}><Crosshair className="h-3.5 w-3.5" aria-hidden /> Focus</Button>
      {miss && <span className="text-[11.5px] text-bad" role="status">No match</span>}
    </form>
  );
}

function GraphPane({ snapshot: s, view, focus, radius, prefix }: { snapshot: Snapshot; view: GView; focus: string | null; radius: number; prefix: string | null }) {
  const nav = useNav();
  const selected = nav.param("node");
  const graph = useAsync(
    () =>
      view === "focus" && !focus
        ? Promise.resolve(null)
        : api.graphView(s.id, { view, focus: view === "focus" ? focus ?? undefined : undefined, radius, path_prefix: view !== "focus" ? prefix ?? undefined : undefined, limit: view === "modules" ? 120 : 220 }),
    [s.id, view, focus, radius, prefix],
  );
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [hiddenRes, setHiddenRes] = useState<Set<string>>(new Set(view === "calls" ? ["unresolved"] : []));
  const [hideIsolated, setHideIsolated] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
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
  const hiddenCount = hiddenKinds.size + hiddenRes.size;

  if (view === "focus" && !focus) {
    return (
      <EmptyState icon={<Crosshair className="h-6 w-6" />} title="Nothing focused">
        Search for a symbol or file above, or use &ldquo;In graph&rdquo; from any symbol to see its neighbourhood.
      </EmptyState>
    );
  }
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5">
        <Button size="sm" variant="ghost" onClick={() => setFiltersOpen(!filtersOpen)} aria-expanded={filtersOpen}>
          <ListFilter className="h-3.5 w-3.5" aria-hidden /> Filters{hiddenCount ? ` (${hiddenCount} hidden)` : ""}
        </Button>
        <label className="inline-flex cursor-pointer items-center gap-1 text-[12px] text-fg-2" title="Hide nodes without any visible relationship">
          <input type="checkbox" checked={hideIsolated} onChange={() => setHideIsolated(!hideIsolated)} className="accent-[var(--accent)]" />
          hide unconnected
        </label>
        {data && (
          <span className="ml-auto text-[11.5px] text-fg-3" aria-live="polite">
            {nodes.length} of {data.nodes.length} nodes · {edges.length} relationships{data.truncated ? " · showing the most connected" : ""}
          </span>
        )}
        {filtersOpen && (
          <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 pt-1">
            <span className="text-[11px] text-fg-3 uppercase">Relationships</span>
            {edgeKinds.map((k) => (
              <label key={k} className="inline-flex cursor-pointer items-center gap-1 text-[12px] text-fg-2">
                <input type="checkbox" checked={!hiddenKinds.has(k)} onChange={() => toggle(hiddenKinds, setHiddenKinds, k)} className="accent-[var(--accent)]" />
                {k.replaceAll("_", " ")}
              </label>
            ))}
            <span className="h-3 w-px bg-line" />
            <span className="text-[11px] text-fg-3 uppercase">Resolution</span>
            {RESOLUTIONS.map((r) => (
              <label key={r} className="inline-flex cursor-pointer items-center gap-1 text-[12px] text-fg-2" title={r === "unresolved" ? "Calls whose target could not be determined statically" : r === "ambiguous" ? "Several possible targets (e.g. overridden methods)" : undefined}>
                <input type="checkbox" checked={!hiddenRes.has(r)} onChange={() => toggle(hiddenRes, setHiddenRes, r)} className="accent-[var(--accent)]" />
                {r}
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="relative min-h-0 flex-1" data-testid="graph-canvas">
        {graph.error ? <div className="p-3"><ErrorState error={graph.error} onRetry={graph.reload} /></div> : null}
        {!data && !graph.error && <div className="p-4"><Spinner label="Laying out the graph" /></div>}
        {data && data.nodes.length === 0 && (
          <EmptyState title="Nothing to show in this view">
            {view === "routes" ? "No API routes were detected in this snapshot." : prefix ? `No nodes under ${prefix}/.` : "No relationships of this kind were resolved."}
          </EmptyState>
        )}
        {data && data.nodes.length > 0 && nodes.length === 0 && <EmptyState title="Every node is unconnected with the current filters">Untick &ldquo;hide unconnected&rdquo; or show more relationship kinds.</EmptyState>}
        {data && nodes.length > 0 && (
          <GraphCanvas
            nodes={nodes}
            edges={edges}
            selected={selected}
            onSelect={(k) => nav.setParams({ node: k })}
            onOpen={(n) => {
              if (n.kind === "module") nav.setParams({ gview: "files", prefix: n.path ?? n.label, node: null });
              else if (n.kind === "file" && n.path) nav.openSource({ path: n.path });
              else if (n.key.startsWith("sym:") || n.kind === "route") nav.openSymbol(n.key);
            }}
            showCounts={view === "modules"}
            fitKey={`${view}:${focus}:${radius}:${prefix}`}
          />
        )}
        <div className="pointer-events-none absolute top-2 left-2 rounded-md border border-line bg-panel/90 px-2 py-1">
          <GraphLegend kinds={nodeKinds} />
        </div>
        {data && nodes.length > 0 && <div className="pointer-events-none absolute right-2 bottom-[108px] rounded bg-panel/80 px-1.5 py-0.5 text-[10.5px] text-fg-3">Click to inspect · double-click to open</div>}
      </div>
    </>
  );
}

function Inspector({ snapshot: s }: { snapshot: Snapshot }) {
  const nav = useNav();
  const key = nav.param("node") ?? nav.param("focus");
  const { setSelection } = nav;
  useEffect(() => {
    if (!key) return;
    const kind = key.startsWith("sym:") ? "symbol" : key.startsWith("file:") ? "file" : key.startsWith("route:") ? "route" : key.startsWith("pkg:") ? "package" : "module";
    setSelection({ kind, key, label: symbolLabel(key), path: keyPath(key) });
  }, [key, setSelection]);
  if (!key) {
    return (
      <EmptyState icon={<Crosshair className="h-5 w-5" />} title="Select a node">
        Click any node to see what it connects to. Double-click a directory to open its files, or a file to read it.
      </EmptyState>
    );
  }
  const kind = key.startsWith("sym:") ? "symbol" : key.startsWith("file:") ? "file" : key.startsWith("route:") ? "route" : key.split(":")[0];
  const path = keyPath(key);
  const isModule = kind === "module" || kind === "dir";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line p-3">
        <div className="flex items-center gap-1.5">
          <Badge tone="accent">{isModule ? "directory" : kind}</Badge>
          <IconButton label="Clear selection" className="ml-auto" onClick={() => nav.setParams({ node: null })}><X className="h-3.5 w-3.5" /></IconButton>
        </div>
        <div className="mt-1 font-mono text-[12.5px] break-all">{isModule ? key.replace(/^[a-z]+:/, "") : symbolLabel(key)}</div>
        {path && <div className="truncate font-mono text-[11px] text-fg-3">{path}</div>}
        <div className="mt-2 flex flex-wrap gap-1">
          {isModule && <Button size="sm" variant="secondary" onClick={() => nav.setParams({ gview: "files", prefix: key.replace(/^[a-z]+:/, ""), node: null })}><FolderTree className="h-3.5 w-3.5" aria-hidden /> Open directory</Button>}
          {path && <Button size="sm" variant="ghost" onClick={() => nav.openSource({ path, sym: key.startsWith("sym:") ? key : undefined })}><FileCode className="h-3.5 w-3.5" aria-hidden /> Source</Button>}
          {!isModule && kind !== "pkg" && <Button size="sm" variant="ghost" onClick={() => nav.openSymbol(key, "impact")}><Radar className="h-3.5 w-3.5" aria-hidden /> Impact</Button>}
          {(kind === "symbol" || kind === "route") && <Button size="sm" variant="ghost" onClick={() => nav.openFlow(key)}><Play className="h-3.5 w-3.5" aria-hidden /> Trace</Button>}
          {!isModule && <Button size="sm" variant="ghost" onClick={() => nav.setParams({ gview: "focus", focus: key, prefix: null })}><Crosshair className="h-3.5 w-3.5" aria-hidden /> Focus</Button>}
          {!isModule && kind !== "pkg" && (
            <Button size="sm" variant="ghost" onClick={() => nav.ask(questionFor("explain", { kind: kind === "file" ? "file" : kind === "route" ? "route" : "symbol", key, label: symbolLabel(key), path }), { send: true })}>
              Explain
            </Button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 text-[12.5px]">{isModule || kind === "pkg" ? <ModuleSummary nodeKey={key} /> : <NodeUsage snapshotId={s.id} nodeKey={key} />}</div>
    </div>
  );
}

function ModuleSummary({ nodeKey }: { nodeKey: string }) {
  return (
    <p className="text-fg-3">
      {nodeKey.startsWith("pkg:")
        ? "An external package. Its imports are counted on the edges; its own code is not analysed."
        : "Edges show resolved imports between directories; their labels count the imports. Open the directory to see the files and their relationships."}
    </p>
  );
}

function NodeUsage({ snapshotId, nodeKey }: { snapshotId: number; nodeKey: string }) {
  const nav = useNav();
  const u = useAsync(() => api.usage(snapshotId, nodeKey), [snapshotId, nodeKey]);
  if (u.error) return <ErrorState error={u.error} compact onRetry={u.reload} />;
  if (!u.data) return <SkeletonRows rows={6} />;
  const d = u.data;
  const select = (k: string) => nav.setParams({ node: k });
  return (
    <div className="space-y-3">
      {d.definition.evidence_id && (
        <div className="flex items-center gap-2"><span className="text-fg-3">Defined at</span><EvidenceChip id={d.definition.evidence_id} /></div>
      )}
      <RelatedBlock title="Used by" items={d.direct_references.map((r) => ({ key: r.key + r.call_line, label: r.label, sub: r.relation, resolution: r.resolution, via: r.via, ev: r.evidence_id, onClick: () => select(r.key) }))} limit={15} empty="No resolved callers or subclasses." />
      {d.imports && <RelatedBlock title="Imports" items={d.imports.map((r) => ({ key: r.key, label: r.label, resolution: r.resolution, ev: r.evidence_id, onClick: () => select(r.key) }))} limit={15} />}
      <RelatedBlock title="Imported by" items={d.importing_files.map((r) => ({ key: r.key, label: r.label, resolution: r.resolution, ev: r.evidence_id, onClick: () => select(r.key) }))} limit={15} />
      <RelatedBlock title="Calls" items={d.direct_callees.map((r) => ({ key: r.key + (r.call_line ?? ""), label: r.label, resolution: r.resolution, via: r.via, ev: r.evidence_id, onClick: () => select(r.key) }))} limit={15} />
      {d.related_routes.length > 0 && <RelatedBlock title="Reached from routes" items={d.related_routes.map((r) => ({ key: r.key, label: r.label, sub: `${r.depth} hops`, onClick: () => nav.openFlow(r.key) }))} />}
    </div>
  );
}
