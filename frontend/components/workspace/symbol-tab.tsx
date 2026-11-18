"use client";

import { FileCode, Network, Play, Radar } from "lucide-react";
import { useMemo } from "react";
import { api, type Impact, type Related, type Usage, type ViewEdge, type ViewNode } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { ACTIONS, questionFor } from "@/components/workspace/actions";
import { GraphCanvas } from "@/components/workspace/graph-canvas";
import { EvidenceChip, keyPath, symbolLabel, useNav } from "@/components/workspace/nav";
import { RelatedBlock, type RelatedItem } from "@/components/workspace/related";
import { Badge, Button, EmptyState, ErrorState, Segmented, SkeletonRows } from "@/components/ui";

type Section = "usage" | "impact" | "dependencies";

/** Deep dive on one symbol, file or route: who uses it, what it depends on, and what a change could affect. */
export function SymbolTab() {
  const nav = useNav();
  const key = nav.param("key");
  const section = (["usage", "impact", "dependencies"].includes(nav.param("section") ?? "") ? nav.param("section") : "usage") as Section;
  const usage = useAsync(() => (key ? api.usage(nav.snapshotId, key) : Promise.resolve(null)), [nav.snapshotId, key]);
  const impact = useAsync(() => (key && section === "impact" ? api.impact(nav.snapshotId, key) : Promise.resolve(null)), [nav.snapshotId, key, section]);
  if (!key) return <EmptyState title="Nothing selected">Open a symbol from the explorer, the outline of a file, or any graph node.</EmptyState>;
  const def = usage.data?.definition;
  const path = def?.path ?? keyPath(key);
  const kind = def?.kind ?? key.split(":")[0];
  const label = def?.label ?? symbolLabel(key);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line bg-panel px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">{kind}</Badge>
          <h2 className="min-w-0 truncate font-mono text-[14px] font-semibold" title={key}>{label}</h2>
          {def?.evidence_id && <EvidenceChip id={def.evidence_id} />}
          <div className="ml-auto flex flex-wrap items-center gap-1">
            {path && (
              <Button size="sm" variant="ghost" onClick={() => nav.openSource({ path, start: def?.start_line, end: def?.end_line, sym: key.startsWith("sym:") ? key : undefined })}>
                <FileCode className="h-3.5 w-3.5" aria-hidden /> Source
              </Button>
            )}
            {(kind === "function" || kind === "method" || kind === "route") && (
              <Button size="sm" variant="ghost" onClick={() => nav.openFlow(key)}>
                <Play className="h-3.5 w-3.5" aria-hidden /> Trace execution
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => nav.openGraph({ gview: "focus", focus: key, node: key })}>
              <Network className="h-3.5 w-3.5" aria-hidden /> In graph
            </Button>
            <Button size="sm" variant="secondary" onClick={() => nav.ask(questionFor(section === "impact" ? "impact" : section === "dependencies" ? "dependencies" : "explain", { kind: key.startsWith("file:") ? "file" : key.startsWith("route:") ? "route" : "symbol", key, label, path, start: def?.start_line, end: def?.end_line, symbolKind: kind }), { send: true })}>
              {section === "impact" ? <ACTIONS.impact.icon className="h-3.5 w-3.5" aria-hidden /> : <ACTIONS.explain.icon className="h-3.5 w-3.5" aria-hidden />}
              Ask the assistant
            </Button>
          </div>
        </div>
        {path && <div className="mt-0.5 truncate font-mono text-[11.5px] text-fg-3">{path}{def?.start_line ? `:${def.start_line}-${def.end_line}` : ""}</div>}
        <div className="mt-2">
          <Segmented
            label="Analysis"
            value={section}
            onChange={(v) => nav.setParams({ section: v })}
            options={[
              { id: "usage", label: "Usage", title: "Who calls or imports this" },
              { id: "dependencies", label: "Dependencies", title: "What this calls or imports" },
              { id: "impact", label: "Change impact", title: "What could be affected if this changes" },
            ]}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {usage.error ? <div className="p-4"><ErrorState error={usage.error} onRetry={usage.reload} /></div> : null}
        {!usage.data && !usage.error && <div className="p-4"><SkeletonRows rows={8} /></div>}
        {usage.data && section === "usage" && <UsageSection u={usage.data} />}
        {usage.data && section === "dependencies" && <DependenciesSection u={usage.data} />}
        {section === "impact" && (impact.error ? <div className="p-4"><ErrorState error={impact.error} onRetry={impact.reload} /></div> : impact.data ? <ImpactSection rootKey={key} rootKind={kind} im={impact.data} /> : <div className="p-4"><SkeletonRows rows={8} /></div>)}
      </div>
    </div>
  );
}

function useOpen() {
  const nav = useNav();
  return (r: Related): (() => void) | undefined => {
    if (r.kind === "route") return () => nav.openSymbol(r.key, "usage");
    if (!r.path) return undefined;
    return () => nav.openSource({ path: r.path as string, start: r.call_line ?? r.start_line, end: r.call_line ?? r.end_line, sym: r.key.startsWith("sym:") ? r.key : undefined });
  };
}

function UsageSection({ u }: { u: Usage }) {
  const open = useOpen();
  const nav = useNav();
  const item = (r: Related, sub?: string): RelatedItem => ({ key: `${r.key}:${r.call_line ?? r.depth ?? ""}`, label: r.label, sub: sub ?? r.path ?? r.kind, resolution: r.resolution, via: r.via, ev: r.evidence_id, onClick: open(r) });
  return (
    <div className="grid gap-5 p-4 lg:grid-cols-2">
      <div className="space-y-4">
        <RelatedBlock title="Direct callers & references" hint="Each is one evidence-backed edge." items={u.direct_references.map((r) => item(r, `${r.relation ?? ""}${r.call_line ? ` · line ${r.call_line}` : ""}`))} empty="No resolved callers. It may be an entry point, unused, or only called dynamically." />
        <RelatedBlock title="Importing files" items={u.importing_files.map((r) => item(r))} empty="No analysed file imports its defining file." />
        <RelatedBlock title="Routes that can reach it" items={u.related_routes.map((r) => ({ key: r.key, label: r.label, sub: `${r.depth} hop${r.depth === 1 ? "" : "s"}`, onClick: () => nav.openFlow(r.key) }))} empty="No API route reaches it through resolved calls." />
      </div>
      <div className="space-y-4">
        <RelatedBlock title="Indirect callers (transitive)" hint="Graph reachability beyond one hop — possible, not proven, usage." items={u.upstream_transitive.map((r) => item(r, `${r.depth} hops`))} limit={40} />
        {u.possible_dynamic_references.length > 0 && (
          <RelatedBlock title="Possible dynamic references" hint="Unresolved calls with the same name; not proven to target this symbol." items={u.possible_dynamic_references.map((r) => ({ key: r.key + (r.evidence_id ?? ""), label: r.callee_text ?? r.label, sub: r.path ?? "", resolution: "unresolved", ev: r.evidence_id }))} />
        )}
      </div>
    </div>
  );
}

function DependenciesSection({ u }: { u: Usage }) {
  const open = useOpen();
  return (
    <div className="grid gap-5 p-4 lg:grid-cols-2">
      <div className="space-y-4">
        {u.imports && <RelatedBlock title="Imports" items={u.imports.map((r) => ({ key: r.key, label: r.kind === "file" ? (r.path ?? r.label) : r.label, sub: r.kind, resolution: r.resolution, ev: r.evidence_id, onClick: r.kind === "file" ? open(r) : undefined }))} empty="No imports were resolved." />}
        <RelatedBlock title="Direct dependencies (calls & bases)" items={u.direct_callees.map((r) => ({ key: `${r.key}:${r.call_line ?? ""}`, label: r.label, sub: `${r.relation ?? ""}${r.call_line ? ` · line ${r.call_line}` : ""}`, resolution: r.resolution, via: r.via, ev: r.evidence_id, onClick: open(r) }))} empty="It makes no resolved calls." />
      </div>
      <RelatedBlock title="Transitive dependencies" hint="Everything reachable through resolved calls, up to 3 hops." items={u.downstream_transitive.map((r) => ({ key: r.key, label: r.label, sub: `${r.depth} hops · ${r.path ?? r.kind}`, resolution: r.resolution, onClick: open(r) }))} limit={60} empty="No dependencies beyond the direct ones." />
    </div>
  );
}

function ImpactSection({ rootKey, rootKind, im }: { rootKey: string; rootKind: string; im: Impact }) {
  const open = useOpen();
  const nav = useNav();
  const graph = useMemo(() => impactGraph(rootKey, rootKind, im), [rootKey, rootKind, im]);
  return (
    <div className="@container">
    <div className="grid gap-0 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="space-y-4 p-4">
        <div className="rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
          <Radar className="mr-1 inline h-3.5 w-3.5" aria-hidden /> Potentially affected, from static reachability (up to 4 hops). This is not proof that anything breaks.
        </div>
        <div className="grid grid-cols-4 gap-2 text-center">
          <Stat n={im.direct_dependents.length} label="direct" />
          <Stat n={im.transitive_dependents.length} label="indirect" />
          <Stat n={im.potentially_affected_routes.length} label="routes" />
          <Stat n={im.related_tests.length} label="tests" />
        </div>
        <RelatedBlock title="Potentially affected routes" items={im.potentially_affected_routes.map((r) => ({ key: r.key, label: r.label, sub: `${r.depth} hops`, onClick: () => nav.openFlow(r.key) }))} empty="No API route reaches it." />
        <RelatedBlock title="Direct dependents" items={im.direct_dependents.map((r) => ({ key: r.key, label: r.label, sub: r.via ?? "", resolution: r.resolution, ev: r.evidence_id, onClick: open(r) }))} />
        <RelatedBlock title="Indirect dependents" items={im.transitive_dependents.map((r) => ({ key: r.key, label: r.label, sub: `${r.depth} hops`, onClick: open(r) }))} limit={40} />
        <RelatedBlock title="Tests that exercise it" items={im.related_tests.map((t) => ({ key: t, label: t, onClick: () => nav.openSource({ path: t }) }))} empty="No analysed test reaches it through resolved calls." />
        {im.unresolved_references.length > 0 && (
          <RelatedBlock title="Unresolved same-name references" hint="Calls that might target it but could not be resolved." items={im.unresolved_references.map((r) => ({ key: r.key + (r.evidence_id ?? ""), label: r.label, sub: r.path ?? "", resolution: "unresolved", ev: r.evidence_id }))} />
        )}
        <ul className="space-y-1 border-t border-line pt-2 text-[11.5px] text-fg-3">{im.limitations.map((n) => <li key={n}>{n}</li>)}</ul>
      </div>
      <div className="h-[460px] border-t border-line @4xl:sticky @4xl:top-0 @4xl:h-[calc(100vh-170px)] @4xl:border-t-0 @4xl:border-l" data-testid="impact-graph">
        {graph.nodes.length > 1 ? (
          <GraphCanvas nodes={graph.nodes} edges={graph.edges} selected={null} onSelect={(k) => k && k !== rootKey && nav.openSymbol(k, "impact")} direction="TB" fitKey={rootKey} />
        ) : (
          <EmptyState title="Nothing depends on it">No resolved caller, importer or subclass was found.</EmptyState>
        )}
      </div>
    </div>
    </div>
  );
}

/** Dependents graph: each reached node points at the node it was reached through (its dependency). */
function impactGraph(rootKey: string, rootKind: string, im: Impact): { nodes: ViewNode[]; edges: ViewEdge[] } {
  const reached = [...im.direct_dependents, ...im.transitive_dependents].slice(0, 120);
  const nodes = new Map<string, ViewNode>();
  nodes.set(rootKey, { key: rootKey, kind: rootKind, label: symbolLabel(rootKey), path: keyPath(rootKey), start_line: null, end_line: null, focus: true });
  for (const r of reached) nodes.set(r.key, { key: r.key, kind: r.kind, label: r.label, path: r.path, start_line: r.start_line, end_line: r.end_line });
  const edges: ViewEdge[] = [];
  for (const r of reached) {
    const through = (r as Related & { through?: string }).through;
    const target = through && nodes.has(through) ? through : rootKey;
    edges.push({ source: r.key, target, kind: r.via ?? "calls", resolution: (r.resolution as ViewEdge["resolution"]) ?? "resolved", count: 1, evidence_id: r.evidence_id ?? null });
  }
  return { nodes: [...nodes.values()], edges };
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="rounded-md border border-line bg-panel-2 py-1.5">
      <div className="font-mono text-[16px] font-semibold tabular-nums">{n}</div>
      <div className="text-[10.5px] text-fg-3 uppercase">{label}</div>
    </div>
  );
}
