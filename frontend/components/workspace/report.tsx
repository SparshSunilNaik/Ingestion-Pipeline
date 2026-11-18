"use client";

import { ChevronDown, ChevronRight, Download, ScrollText, Sparkles } from "lucide-react";
import { useState } from "react";
import { api, type Report, type Section, type Snapshot } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { Badge, Button, EmptyState, ErrorState, Segmented, SkeletonRows, Spinner, cn, formatTime } from "@/components/ui";
import { AiLabel, ClaimList } from "@/components/workspace/claims";
import { EvidenceChip } from "@/components/workspace/nav";

const GROUPS = [
  { key: "overview", title: "Repository overview" },
  { key: "installation", title: "Installation and usage" },
  { key: "architecture", title: "Architecture" },
  { key: "code_structure", title: "Code structure" },
  { key: "engineering", title: "Engineering assessment" },
] as const;

function downloadJson(data: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const anchor = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export function ReportPanel({ snapshot: s }: { snapshot: Snapshot }) {
  const reports = useAsync(() => api.reports(s.id), [s.id]);
  const agent = useAsync(() => api.agentStatus(), []);
  const [pick, setPick] = useState<number | null>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const [polling, setPolling] = useState(false);
  const [reqError, setReqError] = useState<unknown>(null);
  const job = useAsync(() => (jobId ? api.job(jobId) : Promise.resolve(null)), [jobId], polling ? 2000 : null);
  const finished = job.data && ["succeeded", "failed", "cancelled"].includes(job.data.status) ? job.data : null;
  if (polling && finished) setPolling(false);
  const list = useAsync(() => api.reports(s.id), [s.id, finished?.id ?? 0]);
  const all = list.data ?? reports.data ?? [];
  const activeId = pick ?? all[0]?.id ?? null;
  const report = useAsync(() => (activeId ? api.report(activeId) : Promise.resolve(null)), [activeId]);
  const working = jobId !== null && !finished;

  async function generate() {
    setReqError(null);
    try {
      const r = await api.requestAgentReport(s.id);
      setJobId(r.job.id);
      setPolling(true);
      setPick(null);
    } catch (e) {
      setReqError(e);
    }
  }

  const r = report.data;
  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[240px] shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-3 text-[11.5px] font-semibold tracking-wide text-fg-2 uppercase"><ScrollText className="h-3.5 w-3.5" /> Contents</div>
        {r ? <Toc report={r} /> : <div className="p-3"><SkeletonRows /></div>}
      </aside>
      <div className="min-w-0 flex-1 overflow-auto">
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-panel/95 px-4 py-2 backdrop-blur">
          {all.length > 0 && (
            <Segmented
              label="Report version"
              value={String(activeId)}
              onChange={(v) => setPick(Number(v))}
              options={all.slice(0, 4).map((x) => ({ id: String(x.id), label: x.kind === "agent" ? `AI #${x.id}` : `Deterministic #${x.id}`, title: `${x.model ?? "static analysis"} · ${formatTime(x.created_at)}` }))}
            />
          )}
          <div className="ml-auto flex items-center gap-2">
            {r && <a href={api.reportMarkdownUrl(r.id)} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 text-[12px] hover:bg-panel-3"><Download className="h-3.5 w-3.5" /> Markdown</a>}
            {r && <Button size="sm" onClick={() => downloadJson(r.content, `report-${r.id}.json`)}><Download className="h-3.5 w-3.5" /> JSON</Button>}
            <Button size="sm" variant="primary" disabled={!agent.data?.agent_ready || working} onClick={generate} title={agent.data?.agent_ready ? "Generate an AI narrative grounded in this snapshot's evidence" : agent.data?.error ?? "Agent unavailable"}>
              <Sparkles className="h-3.5 w-3.5" /> {working ? `Generating… (${job.data?.stage ?? "queued"})` : "Generate AI report"}
            </Button>
          </div>
        </div>
        <div className="mx-auto max-w-[980px] space-y-5 p-5">
          {reqError ? <ErrorState error={reqError} /> : null}
          {finished && finished.status !== "succeeded" && <ErrorState error={`${finished.error_code}: ${finished.error_message}`} />}
          {report.error ? <ErrorState error={report.error} onRetry={report.reload} /> : null}
          {!r && !report.error && (all.length || reports.loading ? <Spinner label="Loading report" /> : <EmptyState title="No report yet" />)}
          {r && <ReportBody report={r} />}
        </div>
      </div>
    </div>
  );
}

function Toc({ report }: { report: Report }) {
  const c = report.content;
  const groups: { title: string; sections: Section[] }[] = [
    ...(c.agent_narrative.length ? [{ title: "AI interpretation", sections: c.agent_narrative }] : []),
    ...GROUPS.map((g) => ({ title: g.title, sections: c[g.key] })),
  ];
  return (
    <nav className="min-h-0 flex-1 overflow-auto py-2 text-[12.5px]" aria-label="Report contents">
      {groups.map((g) => (
        <div key={g.title} className="mb-2">
          <a href={`#${anchor(g.title)}`} className="block px-3 py-1 font-medium text-fg hover:text-accent">{g.title}</a>
          {g.sections.map((s) => (
            <a key={s.title} href={`#${anchor(g.title + "-" + s.title)}`} className="block truncate py-0.5 pr-3 pl-6 text-fg-3 hover:text-fg">{s.title}</a>
          ))}
        </div>
      ))}
      <a href="#evidence" className="block px-3 py-1 font-medium text-fg hover:text-accent">Evidence</a>
    </nav>
  );
}

function ReportBody({ report }: { report: Report }) {
  const c = report.content;
  const v = (report.usage?.validation ?? null) as Record<string, number> | null;
  const es = c.evidence_summary;
  return (
    <>
      <header className="rounded-lg border border-line bg-panel p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[16px] font-semibold">{c.repository}</h1>
          {c.kind === "agent" ? <AiLabel model={c.model} /> : <Badge>deterministic static analysis</Badge>}
        </div>
        <div className="mt-1 text-[12px] text-fg-3">commit <code className="font-mono">{c.commit_sha}</code> · generated {formatTime(c.generated_at)}</div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge>{es.referenced ?? 0} evidence references</Badge>
          <Badge tone="ok">{es.verified ?? 0} verified</Badge>
          {es.invalid ? <Badge tone="bad">{es.invalid} invalid</Badge> : null}
          {c.coverage.is_partial ? <Badge tone="warn">partial coverage</Badge> : <Badge tone="ok">full coverage within limits</Badge>}
          <Badge>{c.coverage.analyzed_files}/{c.coverage.tracked_files} files analysed</Badge>
          {v && <Badge tone="info">{v.claims} AI claims · {v.source_claims} source · {v.documentation_only_claims} docs-only · {v.unsupported_claims} unsupported</Badge>}
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-fg-3">
          Every statement shows its basis: <b className="text-ok">source</b> cites implementation code, <b className="text-info">config</b> manifests only, <b className="text-warn">docs claim</b> documentation only
          (code not checked), <b>heuristic</b> is a judgement. AI statements are interpretations of cited evidence; only the evidence is machine-verified.
        </p>
      </header>
      {c.agent_narrative.length > 0 && (
        <Group title="AI interpretation" sections={c.agent_narrative} ai model={c.model} />
      )}
      {GROUPS.map((g) => (
        <Group key={g.key} title={g.title} sections={c[g.key]} />
      ))}
      <details id="evidence" className="rounded-lg border border-line bg-panel">
        <summary className="cursor-pointer px-4 py-2.5 text-[13px] font-semibold">Evidence ({c.evidence.length})</summary>
        <table className="w-full text-[12px]">
          <tbody className="divide-y divide-line">
            {c.evidence.map((e) => (
              <tr key={e.id}>
                <td className="px-4 py-1"><EvidenceChip id={e.id} /></td>
                <td className="px-2 py-1 text-fg-3">{e.category.replaceAll("_", " ")}</td>
                <td className="px-2 py-1 text-fg-3">{e.source_kind}</td>
                <td className="px-2 py-1"><Badge tone={e.verification_status === "verified" ? "ok" : "bad"}>{e.verification_status}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

function Group({ title, sections, ai, model }: { title: string; sections: Section[]; ai?: boolean; model?: string | null }) {
  const [open, setOpen] = useState(true);
  return (
    <section id={anchor(title)} className={cn("rounded-lg border bg-panel", ai ? "border-info/30" : "border-line")}>
      <button className="flex w-full items-center gap-2 px-4 py-2.5 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown className="h-4 w-4 text-fg-3" /> : <ChevronRight className="h-4 w-4 text-fg-3" />}
        <h2 className="text-[13.5px] font-semibold">{title}</h2>
        {ai && <AiLabel model={model} />}
      </button>
      {open && (
        <div className="space-y-4 border-t border-line px-4 py-3">
          {sections.map((s) => (
            <div key={s.title} id={anchor(title + "-" + s.title)}>
              <h3 className="mb-1 text-[11.5px] font-semibold tracking-wide text-fg-3 uppercase">{s.title}</h3>
              <ClaimList claims={s.claims} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
