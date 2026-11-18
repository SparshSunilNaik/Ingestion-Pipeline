"use client";

import { GitCompare, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, type Snapshot } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { Badge, Button, EmptyState, ErrorState, Metric, Panel, ShortSha, SkeletonRows, cn, formatTime } from "@/components/ui";
import { EvidenceChip, useNav } from "@/components/workspace/nav";

export function Compare({ snapshot: s }: { snapshot: Snapshot }) {
  const nav = useNav();
  const repo = useAsync(() => api.repositories().then((rs) => rs.find((r) => r.id === s.repository.id) ?? null), [s.repository.id]);
  const others = (repo.data?.snapshots ?? []).filter((x) => x.id !== s.id && x.status === "ready");
  const base = Number(nav.param("base")) || others[0]?.id || null;
  const cmp = useAsync(() => (base ? api.compare(base, s.id) : Promise.resolve(null)), [base, s.id]);
  const c = cmp.data;

  if (repo.data && others.length === 0)
    return (
      <EmptyState
        icon={<GitCompare className="h-6 w-6" />}
        title="Only one analysed snapshot"
        action={<RefreshForCompare repositoryId={s.repository.id} />}
      >
        Comparison needs a second analysed commit of {s.repository.owner}/{s.repository.name}. Refresh the analysis to check GitHub for a newer commit; this snapshot is kept.
      </EmptyState>
    );

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1400px] space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-[12.5px]">
          <span className="text-fg-3">Base</span>
          <select value={base ?? ""} onChange={(e) => nav.setParams({ base: e.target.value })} aria-label="Base snapshot" className="h-7 rounded-md border border-line bg-panel-2 px-2 font-mono text-[12px]">
            {others.map((o) => (
              <option key={o.id} value={o.id}>#{o.id} {o.commit_sha.slice(0, 10)} · {o.analyzer_version} · {formatTime(o.acquired_at)}</option>
            ))}
          </select>
          <span className="text-fg-3">→ Head</span>
          <ShortSha sha={s.commit_sha} /> <span className="text-fg-3">#{s.id} · {s.analyzer_version}</span>
        </div>
        {cmp.error ? <ErrorState error={cmp.error} onRetry={cmp.reload} /> : null}
        {!c && !cmp.error && <SkeletonRows rows={8} />}
        {c && (
          <>
            <div className="grid grid-cols-2 gap-4 rounded-lg border border-line bg-panel px-4 py-3 sm:grid-cols-4 lg:grid-cols-8">
              <Metric label="Files +" value={c.files.counts.added} />
              <Metric label="Files −" value={c.files.counts.removed} />
              <Metric label="Modified" value={c.files.counts.modified} />
              <Metric label="Symbols +" value={c.symbols.counts.added} />
              <Metric label="Symbols −" value={c.symbols.counts.removed} />
              <Metric label="Signatures" value={c.symbols.counts.signature_changed} />
              <Metric label="Edges ±" value={`${c.graph.counts.added}/${c.graph.counts.removed}`} />
              <Metric label="Impacted" value={c.potential_impact.count} tone={c.potential_impact.count ? "warn" : undefined} />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Panel title="Files">
                <DiffList items={[
                  ...c.files.added.map((p) => ({ k: `a${p}`, sign: "+", label: p, onClick: () => nav.openSource({ path: p }) })),
                  ...c.files.removed.map((p) => ({ k: `r${p}`, sign: "−", label: p })),
                  ...c.files.modified.map((m) => ({ k: `m${m.path}`, sign: "~", label: m.path, sub: `${m.lines_before ?? "?"} → ${m.lines_after ?? "?"} lines`, onClick: () => nav.openSource({ path: m.path }) })),
                ]} />
              </Panel>
              <Panel title="Symbols">
                <DiffList items={[
                  ...c.symbols.added.map((x) => ({ k: `a${x.path}${x.qualified_name}`, sign: "+", label: x.qualified_name, sub: `${x.kind} · ${x.path}`, onClick: () => nav.openSource({ path: x.path, start: x.start_line, end: x.end_line }) })),
                  ...c.symbols.removed.map((x) => ({ k: `r${x.path}${x.qualified_name}`, sign: "−", label: x.qualified_name, sub: `${x.kind} · ${x.path}` })),
                  ...c.symbols.signature_changed.map((x) => ({ k: `s${x.path}${x.qualified_name}`, sign: "~", label: x.qualified_name, sub: `${x.signature_before ?? ""} → ${x.signature_after ?? ""}`, onClick: () => nav.openSource({ path: x.path, start: x.start_line, end: x.end_line }) })),
                ]} />
              </Panel>
              <Panel title="Dependencies & routes">
                <DiffList items={[
                  ...c.dependencies.added.map((d) => ({ k: `da${d.name}${d.scope}`, sign: "+", label: `${d.ecosystem}:${d.name}`, sub: d.specifier ?? "" })),
                  ...c.dependencies.removed.map((d) => ({ k: `dr${d.name}${d.scope}`, sign: "−", label: `${d.ecosystem}:${d.name}`, sub: d.specifier ?? "" })),
                  ...c.dependencies.changed.map((d) => ({ k: `dc${d.name}${d.scope}`, sign: "~", label: `${d.ecosystem}:${d.name}`, sub: `${d.specifier_before ?? ""} → ${d.specifier ?? ""} (${d.status_before} → ${d.status})` })),
                  ...c.routes.added.map((r) => ({ k: `ra${r.name}${r.path}`, sign: "+", label: r.name, sub: r.path })),
                  ...c.routes.removed.map((r) => ({ k: `rr${r.name}${r.path}`, sign: "−", label: r.name, sub: r.path })),
                ]} />
              </Panel>
              <Panel title="Potential impact">
                <p className="mb-2 text-[12px] text-fg-3">{c.potential_impact.note}</p>
                <ul className="space-y-1">
                  {c.potential_impact.unchanged_dependents_of_changed_code.map((i) => (
                    <li key={i.key} className="flex items-center gap-2 text-[12.5px]">
                      <button className="min-w-0 truncate text-left font-mono text-[12px] hover:text-accent" onClick={() => nav.focusGraph(i.key, "impact")}>{i.label}</button>
                      <span className="shrink-0 truncate text-[11px] text-fg-3">references {i.because_of.split("#").pop()}</span>
                      {i.evidence_id ? <EvidenceChip id={i.evidence_id} /> : null}
                    </li>
                  ))}
                  {c.potential_impact.count === 0 && <li className="text-[12px] text-fg-3">No unchanged code statically references the changed code.</li>}
                </ul>
              </Panel>
            </div>
            <Panel title={`Graph relationships (+${c.graph.counts.added} / −${c.graph.counts.removed})`}>
              <DiffList items={[
                ...c.graph.edges_added.slice(0, 80).map((e, i) => ({ k: `ea${i}`, sign: "+", label: `${e.source.split("#").pop()} ${e.kind} ${e.target.split("#").pop()}`, sub: e.resolution })),
                ...c.graph.edges_removed.slice(0, 80).map((e, i) => ({ k: `er${i}`, sign: "−", label: `${e.source.split("#").pop()} ${e.kind} ${e.target.split("#").pop()}`, sub: e.resolution })),
              ]} />
            </Panel>
            <Panel title="Limitations">
              <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-fg-2">{c.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}

function DiffList({ items }: { items: { k: string; sign: string; label: string; sub?: string; onClick?: () => void }[] }) {
  if (!items.length) return <p className="text-[12px] text-fg-3">No changes.</p>;
  return (
    <ul className="max-h-[340px] space-y-0.5 overflow-auto">
      {items.map((it) => (
        <li key={it.k} className="flex items-center gap-2 text-[12.5px]">
          <Badge tone={it.sign === "+" ? "ok" : it.sign === "−" ? "bad" : "warn"} className="w-5 justify-center">{it.sign}</Badge>
          <button disabled={!it.onClick} onClick={it.onClick} className={cn("min-w-0 truncate text-left font-mono text-[12px]", it.onClick && "hover:text-accent")}>{it.label}</button>
          {it.sub && <span className="min-w-0 truncate text-[11px] text-fg-3">{it.sub}</span>}
        </li>
      ))}
    </ul>
  );
}

function RefreshForCompare({ repositoryId }: { repositoryId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="mt-2 flex flex-col items-center gap-2">
      <Button
        variant="primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          api.refreshRepository(repositoryId).then(
            (r) => router.push(`/jobs/${r.job.id}`),
            (e) => {
              setError(e);
              setBusy(false);
            },
          );
        }}
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh analysis
      </Button>
      <ErrorState error={error} compact />
    </div>
  );
}
