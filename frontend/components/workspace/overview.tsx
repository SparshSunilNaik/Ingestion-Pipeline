"use client";

import { Boxes, CircleExclamationPoint, Cpu, Gauge, Network, Play, Route, ScrollText, Sparkles } from "lucide-react";
import { api, type Snapshot } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { MermaidDiagram, moduleDiagram } from "@/components/mermaid-diagram";
import { Badge, Button, LanguageBar, Metric, Panel, SkeletonRows, formatBytes } from "@/components/ui";
import { AiLabel, ClaimList, findSection } from "@/components/workspace/claims";
import { EvidenceChip, useNav } from "@/components/workspace/nav";

export function Overview({ snapshot: s }: { snapshot: Snapshot }) {
  const nav = useNav();
  const reports = useAsync(() => api.reports(s.id), [s.id]);
  const detId = reports.data?.find((r) => r.kind === "deterministic")?.id;
  const agentId = reports.data?.find((r) => r.kind === "agent")?.id;
  const det = useAsync(() => (detId ? api.report(detId) : Promise.resolve(null)), [detId]);
  const agent = useAsync(() => (agentId ? api.report(agentId) : Promise.resolve(null)), [agentId]);
  const findings = useAsync(() => api.findings(s.id), [s.id]);
  const modules = useAsync(() => api.graphView(s.id, { view: "modules", limit: 60 }), [s.id]);
  const d = det.data?.content;
  const a = agent.data?.content;
  const fws = findings.data?.filter((f) => f.kind === "framework") ?? [];
  const entries = findings.data?.filter((f) => f.kind === "entry_point") ?? [];
  const routes = findings.data?.filter((f) => f.kind === "route") ?? [];
  const stats = s.analysis_summary.stats ?? {};
  const g = s.analysis_summary.graph;
  const diagram = modules.data ? moduleDiagram(modules.data) : null;

  const warnings: string[] = [];
  if (s.coverage.is_partial) warnings.push(`Partial coverage: ${s.coverage.budget_skipped_files} eligible file(s) skipped by size/count limits.`);
  if (stats.files_with_parse_issues) warnings.push(`${stats.files_with_parse_issues} file(s) had parse errors; their symbols may be incomplete.`);
  if (stats.calls_dynamic_receiver) warnings.push(`${stats.calls_dynamic_receiver} call sites on dynamic receivers were not resolved (not guessed).`);
  if (g?.edge_resolution?.ambiguous) warnings.push(`${g.edge_resolution.ambiguous} relationships are ambiguous (e.g. overridden methods called through self/this).`);
  const docOnly = (d?.overview ?? []).flatMap((x) => x.claims).filter((c) => c.basis === "documentation_claim").length;
  if (docOnly) warnings.push(`${docOnly} overview statement(s) rest only on documentation and were not verified against code.`);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto grid max-w-[1500px] gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="What this repository does" icon={<Boxes className="h-3.5 w-3.5" />} actions={a ? <AiLabel model={a.model} /> : <Button size="sm" variant="ghost" onClick={() => nav.setView("report")}><Sparkles className="h-3.5 w-3.5" /> Generate AI summary</Button>}>
            {!d && <SkeletonRows rows={3} />}
            {a && (
              <div className="mb-3 rounded-md border border-info/25 bg-info-soft/40 p-2">
                <ClaimList claims={findSection(a.agent_narrative, "Purpose")} />
              </div>
            )}
            {d && <ClaimList claims={findSection(d.overview, "Purpose")} />}
          </Panel>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Key features" icon={<Sparkles className="h-3.5 w-3.5" />} actions={a ? <AiLabel /> : null}>
              {a ? <ClaimList claims={findSection(a.agent_narrative, "Key features")} /> : null}
              {d && <div className={a ? "mt-2 border-t border-line pt-2" : ""}><ClaimList claims={findSection(d.overview, "Key features")} /></div>}
            </Panel>
            <Panel title="Technologies" icon={<Cpu className="h-3.5 w-3.5" />}>
              <LanguageBar data={s.inventory_summary.languages_by_bytes} />
              <ul className="mt-3 space-y-1.5">
                {fws.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-2 text-[12.5px]">
                    <span>
                      {f.name} <span className="text-fg-3">{String(f.detail.role ?? "")}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Badge tone={f.confidence === "observed" ? "ok" : "info"} title={f.confidence === "observed" ? "Imported in analysed source" : "Declared in a manifest; no import observed"}>
                        {f.confidence === "observed" ? "imported" : "declared only"}
                      </Badge>
                      {f.evidence_id && <EvidenceChip id={f.evidence_id} />}
                    </span>
                  </li>
                ))}
                {findings.data && !fws.length && <li className="text-[12.5px] text-fg-3">No supported framework evidence.</li>}
              </ul>
            </Panel>
          </div>
          <Panel title="Architecture summary" icon={<Network className="h-3.5 w-3.5" />} actions={<Button size="sm" variant="ghost" onClick={() => nav.setView("architecture")}>Explore graph</Button>}>
            {a && <div className="mb-3"><div className="mb-1"><AiLabel /></div><ClaimList claims={findSection(a.agent_narrative, "High-level architecture")} /></div>}
            {modules.data ? (diagram ? <MermaidDiagram definition={diagram} /> : <p className="text-[12.5px] text-fg-3">No resolved cross-directory imports to diagram.</p>) : <SkeletonRows rows={4} />}
            <p className="mt-2 text-[11.5px] text-fg-3">Directory groups and counts of resolved import edges between them, from static analysis.</p>
            {d && <div className="mt-3 border-t border-line pt-2"><ClaimList dense claims={findSection(d.architecture, "Component relationships").slice(0, 6)} /></div>}
          </Panel>
          <Panel title="Installation & usage" icon={<ScrollText className="h-3.5 w-3.5" />}>
            {d ? (
              <div className="grid gap-4 md:grid-cols-2">
                {["Prerequisites", "Installation instructions", "Startup commands", "Example usage"].map((t) => (
                  <div key={t}>
                    <h3 className="mb-1 text-[11.5px] font-semibold tracking-wide text-fg-3 uppercase">{t}</h3>
                    <ClaimList dense claims={findSection(d.installation, t).slice(0, 6)} />
                  </div>
                ))}
              </div>
            ) : (
              <SkeletonRows />
            )}
            <p className="mt-2 text-[11.5px] text-fg-3">Commands come from documentation and manifests. None were executed.</p>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {warnings.length > 0 && (
            <Panel title="Warnings" icon={<CircleExclamationPoint className="h-3.5 w-3.5 text-warn" />}>
              <ul className="space-y-1.5 text-[12.5px] text-fg-2">
                {warnings.map((w) => (
                  <li key={w} className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />{w}</li>
                ))}
              </ul>
            </Panel>
          )}
          <Panel title="Analysis coverage" icon={<Gauge className="h-3.5 w-3.5" />}>
            <div className="grid grid-cols-3 gap-3">
              <Metric label="Tracked" value={s.coverage.tracked_files} />
              <Metric label="Analysed" value={s.coverage.analyzed_files} tone={s.coverage.is_partial ? "warn" : undefined} />
              <Metric label="Size" value={formatBytes(s.coverage.analyzed_bytes)} />
              <Metric label="Evidence" value={s.analysis_summary.evidence_records ?? 0} />
              <Metric label="Graph nodes" value={g?.nodes ?? 0} />
              <Metric label="Edges" value={g?.edges ?? 0} />
            </div>
            {g?.edge_resolution && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {Object.entries(g.edge_resolution).map(([k, v]) => (
                  <Badge key={k} tone={k === "resolved" ? "ok" : k === "ambiguous" ? "warn" : k === "external" ? "info" : "bad"}>{v} {k}</Badge>
                ))}
              </div>
            )}
            {Object.keys(s.coverage.exclusions).length > 0 && (
              <div className="mt-3 text-[12px] text-fg-3">
                Excluded: {Object.entries(s.coverage.exclusions).map(([k, v]) => `${k.replaceAll("_", " ")} ${v}`).join(" · ")}
              </div>
            )}
          </Panel>
          <Panel title={`Entry points & routes (${entries.length + routes.length})`} icon={<Route className="h-3.5 w-3.5" />} bodyClassName="p-0">
            <ul className="max-h-[360px] divide-y divide-line overflow-auto">
              {[...routes, ...entries].map((f) => (
                <li key={f.id} className="flex items-center gap-2 px-3 py-1.5 text-[12.5px]">
                  <Badge tone={f.kind === "route" ? "accent" : "neutral"}>{f.kind === "route" ? String(f.detail.framework ?? "route") : "entry"}</Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={f.name}>{f.name}</span>
                  {f.kind === "route" && f.detail.route_key ? (
                    <button className="text-fg-3 hover:text-accent" title="Trace possible execution flow" aria-label={`Trace flow for ${f.name}`} onClick={() => nav.setParams({ view: "architecture", gview: "flows", entry: String(f.detail.route_key) })}>
                      <Play className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  {f.evidence_id && <EvidenceChip id={f.evidence_id} />}
                </li>
              ))}
              {findings.data && entries.length + routes.length === 0 && <li className="px-3 py-3 text-[12.5px] text-fg-3">No entry points or routes detected.</li>}
            </ul>
          </Panel>
          <Panel title="Most referenced code">
            <ul className="space-y-1">
              {(s.analysis_summary.most_referenced_symbols ?? []).slice(0, 10).map((m) => (
                <li key={m.key} className="flex items-center justify-between gap-2 text-[12.5px]">
                  <button className="min-w-0 truncate text-left font-mono text-[12px] hover:text-accent" onClick={() => nav.focusGraph(m.key, "usage")} title={`${m.path} — show usage`}>{m.label}</button>
                  <span className="shrink-0 text-[11.5px] text-fg-3">{m.references} refs</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
