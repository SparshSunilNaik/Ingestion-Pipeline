"use client";

import { CircleExclamationPoint, Compass, MessagesSquare, Network, Play, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { api, type Snapshot } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { MermaidDiagram, moduleDiagram } from "@/components/mermaid-diagram";
import { Badge, Button, LanguageBar, Metric, SkeletonRows, formatBytes } from "@/components/ui";
import { questionFor } from "@/components/workspace/actions";
import { AiLabel, ClaimList, findSection } from "@/components/workspace/claims";
import { EvidenceChip, useNav } from "@/components/workspace/nav";

function Section({ title, action, children, id }: { title: string; action?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section aria-labelledby={id} className="border-t border-line pt-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id={id} className="atlas-label !text-fg-2">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A readable briefing on the repository: what it does, where to start, how it is built, how reliable the analysis is. */
export function Overview({ snapshot: s }: { snapshot: Snapshot }) {
  const nav = useNav();
  const reports = useAsync(() => api.reports(s.id), [s.id]);
  const detId = reports.data?.find((r) => r.kind === "deterministic")?.id;
  const agentId = reports.data?.find((r) => r.kind === "agent")?.id;
  const det = useAsync(() => (detId ? api.report(detId) : Promise.resolve(null)), [detId]);
  const agent = useAsync(() => (agentId ? api.report(agentId) : Promise.resolve(null)), [agentId]);
  const findings = useAsync(() => api.findings(s.id), [s.id]);
  const eps = useAsync(() => api.entryPoints(s.id), [s.id]);
  const modules = useAsync(() => api.graphView(s.id, { view: "modules", limit: 40 }), [s.id]);
  const d = det.data?.content;
  const a = agent.data?.content;
  const fws = findings.data?.filter((f) => f.kind === "framework") ?? [];
  const stats = s.analysis_summary.stats ?? {};
  const g = s.analysis_summary.graph;
  const diagram = modules.data && modules.data.nodes.length > 1 ? moduleDiagram(modules.data) : null;
  const traceable = (eps.data ?? []).filter((e) => e.traceable && e.start_key);
  const firstEntry = traceable.find((e) => e.kind === "route") ?? traceable[0];
  const topSymbol = s.analysis_summary.most_referenced_symbols?.[0];

  const warnings: string[] = [];
  if (s.coverage.is_partial) warnings.push(`Partial coverage: ${s.coverage.budget_skipped_files} eligible file(s) were skipped by size or count limits.`);
  if (stats.files_with_parse_issues) warnings.push(`${stats.files_with_parse_issues} file(s) had syntax errors; their symbols may be incomplete.`);
  if (stats.calls_dynamic_receiver) warnings.push(`${stats.calls_dynamic_receiver} call sites on dynamic values were left unresolved rather than guessed.`);
  if (g?.edge_resolution?.ambiguous) warnings.push(`${g.edge_resolution.ambiguous} relationships are ambiguous (for example a method that subclasses override).`);
  const docOnly = (d?.overview ?? []).flatMap((x) => x.claims).filter((c) => c.basis === "documentation_claim").length;
  if (docOnly) warnings.push(`${docOnly} statement(s) below come only from documentation and were not verified against code.`);

  return (
    <div className="@container h-full overflow-auto">
      <div className="mx-auto max-w-[1040px] space-y-5 px-5 py-5">
        <header>
          <div className="atlas-label">{s.repository.owner} · {s.default_branch ?? "HEAD"} @ {s.commit_sha.slice(0, 12)} · analyzer {s.analyzer_version}</div>
          <h1 className="atlas-display mt-1.5 text-[clamp(34px,3.6vw,52px)] text-fg">{s.repository.name}</h1>
          {s.commit_info.subject && <p className="mt-1 truncate font-mono text-[11.5px] text-fg-3" title={s.commit_info.subject}>last commit — “{s.commit_info.subject}”</p>}
          <div className="mt-3 max-w-[520px]"><LanguageBar data={s.inventory_summary.languages_by_bytes} /></div>
        </header>

        <section aria-label="Where to start" className="grid gap-2 @2xl:grid-cols-3">
          {firstEntry?.start_key ? (
            <StartCard
              icon={<Play className="h-4 w-4" />}
              title={`Trace ${firstEntry.label}`}
              text={`Follow what happens from ${firstEntry.kind === "route" ? "this route" : "this entry point"}, step by step.`}
              onClick={() => nav.openFlow(firstEntry.start_key as string)}
            />
          ) : topSymbol ? (
            <StartCard
              icon={<Play className="h-4 w-4" />}
              title={`Trace ${topSymbol.label}`}
              text="No route or main function was detected (often a library), so start from its most used code."
              onClick={() => nav.openFlow(topSymbol.key)}
            />
          ) : (
            <StartCard icon={<Play className="h-4 w-4" />} title="Browse the code" text="No entry point was detected. Open a file and use “Trace execution” on any function." onClick={() => nav.openGraph({ gview: "files" })} />
          )}
          <StartCard icon={<Network className="h-4 w-4" />} title="Explore the architecture" text="Directories, files, calls and routes as an interactive graph." onClick={() => nav.openGraph()} />
          <StartCard
            icon={<MessagesSquare className="h-4 w-4" />}
            title="Ask the assistant"
            text={topSymbol ? `For example: how is ${topSymbol.label} used?` : "Ask how something works; answers cite source lines."}
            onClick={() => nav.ask(questionFor("architecture", null), { send: false })}
          />
        </section>

        <Section
          title="What it does"
          id="ov-purpose"
          action={a ? <AiLabel model={a.model} /> : <Button size="sm" variant="ghost" onClick={() => nav.setView("report")}><Sparkles className="h-3.5 w-3.5" aria-hidden /> Generate an AI summary</Button>}
        >
          {!d && <SkeletonRows rows={3} />}
          {a && <div className="mb-2 rounded-md bg-info-soft px-2 py-1"><ClaimList claims={findSection(a.agent_narrative, "Purpose")} /></div>}
          {d && <ClaimList claims={findSection(d.overview, "Purpose")} empty="The repository has no description in its documentation or manifests." />}
          {d && findSection(d.overview, "Key features").length > 0 && (
            <div className="mt-3">
              <h3 className="mb-1 text-[11.5px] font-semibold tracking-wide text-fg-3 uppercase">Key features</h3>
              {a && <ClaimList claims={findSection(a.agent_narrative, "Key features")} />}
              <ClaimList claims={findSection(d.overview, "Key features")} />
            </div>
          )}
        </Section>

        <div className="grid gap-5 @3xl:grid-cols-2">
          <Section title={`Entry points & routes · ${eps.data?.length ?? "…"}`} id="ov-entries">
            {!eps.data && <SkeletonRows rows={4} />}
            {eps.data?.length === 0 && <p className="text-[12.5px] text-fg-3">No routes, main functions or CLI entry points were detected.</p>}
            <ul className="space-y-0.5">
              {(eps.data ?? []).slice(0, 12).map((e) => (
                <li key={`${e.kind}:${e.label}:${e.start_key}`} className="flex items-center gap-2 text-[12.5px]">
                  <Badge tone={e.kind === "route" ? "accent" : "neutral"}>{e.kind === "route" ? e.framework ?? "route" : e.kind.replaceAll("_", " ")}</Badge>
                  <button disabled={!e.traceable || !e.start_key} onClick={() => e.start_key && nav.openFlow(e.start_key)} className="min-w-0 flex-1 truncate text-left font-mono text-[12px] hover:text-accent disabled:hover:text-fg" title={e.traceable ? "Trace possible execution" : "The handler could not be resolved"}>
                    {e.label}
                  </button>
                  {e.evidence_id && <EvidenceChip id={e.evidence_id} />}
                </li>
              ))}
            </ul>
            {(eps.data?.length ?? 0) > 12 && <p className="mt-1 text-[11.5px] text-fg-3">All {eps.data?.length} are listed in the explorer under Entry points.</p>}
          </Section>

          <Section title="Most used code" id="ov-central">
            {(s.analysis_summary.most_referenced_symbols ?? []).length === 0 && <p className="text-[12.5px] text-fg-3">No cross-file references were resolved.</p>}
            <ul className="space-y-0.5">
              {(s.analysis_summary.most_referenced_symbols ?? []).slice(0, 10).map((m) => (
                <li key={m.key} className="flex items-center gap-2 text-[12.5px]">
                  <button className="min-w-0 flex-1 truncate text-left font-mono text-[12px] hover:text-accent" onClick={() => nav.openSymbol(m.key)} title={`${m.path} — who uses it`}>{m.label}</button>
                  <span className="shrink-0 text-[11px] text-fg-3">{m.kind} · {m.references} refs</span>
                </li>
              ))}
            </ul>
          </Section>
        </div>

        <Section title="How it is built" id="ov-arch" action={<Button size="sm" variant="ghost" onClick={() => nav.openGraph()}><Compass className="h-3.5 w-3.5" aria-hidden /> Open the graph</Button>}>
          <div className="grid gap-5 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div>
              <h3 className="mb-1 text-[11.5px] font-semibold tracking-wide text-fg-3 uppercase">Technologies</h3>
              <ul className="space-y-1">
                {fws.map((f) => (
                  <li key={f.id} className="flex items-center gap-2 text-[12.5px]">
                    <span className="min-w-0 flex-1 truncate">{f.name} <span className="text-fg-3">{String(f.detail.role ?? "")}</span></span>
                    <Badge tone={f.confidence === "observed" ? "ok" : "info"} title={f.confidence === "observed" ? "Imported in analysed source" : "Declared in a manifest; no import observed"}>{f.confidence === "observed" ? "used in code" : "declared only"}</Badge>
                    {f.evidence_id && <EvidenceChip id={f.evidence_id} />}
                  </li>
                ))}
                {findings.data && !fws.length && <li className="text-[12.5px] text-fg-3">No supported framework was detected.</li>}
              </ul>
              {a && <div className="mt-3"><AiLabel /><div className="mt-1"><ClaimList claims={findSection(a.agent_narrative, "High-level architecture")} /></div></div>}
              {d && <div className="mt-3"><ClaimList dense claims={findSection(d.architecture, "Component relationships").slice(0, 5)} /></div>}
            </div>
            <div>
              {modules.data ? (
                diagram ? <MermaidDiagram definition={diagram} /> : <p className="text-[12.5px] text-fg-3">All code is in one directory, so there are no cross-directory imports to draw. The graph shows file-level relationships.</p>
              ) : (
                <SkeletonRows rows={4} />
              )}
              {diagram && <p className="mt-1 text-[11px] text-fg-3">Directories and counts of resolved imports between them.</p>}
            </div>
          </div>
        </Section>

        <Section title="How to run it" id="ov-run">
          {d ? (
            <div className="grid gap-4 @2xl:grid-cols-2">
              {["Prerequisites", "Installation instructions", "Startup commands", "Example usage"].map((t) => (
                <div key={t}>
                  <h3 className="mb-1 text-[11.5px] font-semibold tracking-wide text-fg-3 uppercase">{t}</h3>
                  <ClaimList dense claims={findSection(d.installation, t).slice(0, 5)} />
                </div>
              ))}
            </div>
          ) : (
            <SkeletonRows />
          )}
          <p className="mt-2 text-[11.5px] text-fg-3">Taken from documentation and manifests. Nothing was executed.</p>
        </Section>

        <Section title="How reliable this analysis is" id="ov-quality">
          {warnings.length > 0 && (
            <ul className="mb-3 space-y-1 text-[12.5px] text-fg-2">
              {warnings.map((w) => (
                <li key={w} className="flex gap-2"><CircleExclamationPoint className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden />{w}</li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-3 gap-3 @2xl:grid-cols-6">
            <Metric label="Tracked files" value={s.coverage.tracked_files} />
            <Metric label="Analysed" value={s.coverage.analyzed_files} tone={s.coverage.is_partial ? "warn" : undefined} />
            <Metric label="Size" value={formatBytes(s.coverage.analyzed_bytes)} />
            <Metric label="Evidence" value={s.analysis_summary.evidence_records ?? 0} />
            <Metric label="Graph nodes" value={g?.nodes ?? 0} />
            <Metric label="Relationships" value={g?.edges ?? 0} />
          </div>
          {g?.edge_resolution && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {Object.entries(g.edge_resolution).map(([k, v]) => (
                <Badge key={k} tone={k === "resolved" ? "ok" : k === "ambiguous" ? "warn" : k === "external" ? "info" : "bad"}>{v} {k}</Badge>
              ))}
            </div>
          )}
          {Object.keys(s.coverage.exclusions).length > 0 && (
            <p className="mt-2 text-[12px] text-fg-3">Not analysed: {Object.entries(s.coverage.exclusions).map(([k, v]) => `${k.replaceAll("_", " ")} ${v}`).join(" · ")}</p>
          )}
          <p className="mt-1 text-[11.5px] text-fg-3">Analyzer {s.analyzer_version}. Every fact links to a verified source location at this commit.</p>
        </Section>
      </div>
    </div>
  );
}

function StartCard({ icon, title, text, onClick }: { icon: ReactNode; title: string; text: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="group flex items-start gap-3 rounded-lg border border-line bg-panel px-3.5 py-3 text-left transition-colors hover:border-accent">
      <span className="mt-0.5 text-accent">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold group-hover:text-accent">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-fg-3">{text}</span>
      </span>
    </button>
  );
}
