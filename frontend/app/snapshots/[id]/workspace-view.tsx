"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { api, type Snapshot } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { GraphExplorer } from "@/components/graph-explorer";
import { MermaidDiagram, componentDiagram } from "@/components/mermaid-diagram";
import { ReportView, type OpenEvidence } from "@/components/report-view";
import { SourceViewer } from "@/components/source-viewer";
import { Badge, Button, Card, Empty, ErrorBox, ShortSha, Spinner, Stat, Tabs, TextLink, formatBytes, formatTime } from "@/components/ui";

type Tab = "overview" | "files" | "architecture" | "report" | "source";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "files", label: "Files" },
  { id: "architecture", label: "Architecture" },
  { id: "report", label: "Report" },
  { id: "source", label: "Source" },
];

export function WorkspaceView() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = (search.get("tab") as Tab) || "overview";
  const snap = useAsync(() => api.snapshot(id), [id]);

  const setQuery = useCallback(
    (patch: Record<string, string | null>) => {
      const sp = new URLSearchParams(search.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) sp.delete(k);
        else sp.set(k, v);
      }
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
    },
    [pathname, router, search],
  );

  const openEvidence: OpenEvidence = useCallback(
    ({ path, start, end }) => setQuery({ tab: "source", path, start: String(start), end: String(end) }),
    [setQuery],
  );

  if (snap.error) return <ErrorBox error={snap.error} />;
  if (!snap.data) return <Spinner label="Loading snapshot" />;
  const s = snap.data;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            {s.repository.owner}/{s.repository.name}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            <a href={s.repository.canonical_url} target="_blank" rel="noreferrer noopener" className="hover:underline">{s.repository.canonical_url}</a>
            <span>·</span>
            <span>branch {s.default_branch ?? "unknown"}</span>
            <span>·</span>
            <ShortSha sha={s.commit_sha} />
            <Badge tone={s.status === "ready" ? "ok" : "warn"}>{s.status}</Badge>
            {s.coverage.is_partial ? <Badge tone="warn">partial coverage</Badge> : null}
          </div>
        </div>
      </div>
      <Tabs tabs={TABS} active={tab} onChange={(t) => setQuery({ tab: t })} />
      {tab === "overview" ? <Overview snapshot={s} onOpen={openEvidence} /> : null}
      {tab === "files" ? <Files snapshotId={id} onOpen={(path) => openEvidence({ path, start: 1, end: 1 })} /> : null}
      {tab === "architecture" ? <Architecture snapshotId={id} onOpen={openEvidence} /> : null}
      {tab === "report" ? <ReportTab snapshotId={id} onOpen={openEvidence} /> : null}
      {tab === "source" ? (
        search.get("path") ? (
          <SourceViewer snapshotId={id} path={search.get("path")!} start={Number(search.get("start")) || undefined} end={Number(search.get("end")) || undefined} />
        ) : (
          <Empty>Select an evidence reference or a file to view its source.</Empty>
        )
      ) : null}
    </div>
  );
}

function Bars({ data }: { data: Record<string, number> }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const total = entries.reduce((a, [, v]) => a + v, 0) || 1;
  if (entries.length === 0) return <Empty>None detected.</Empty>;
  return (
    <ul className="space-y-1.5 text-sm">
      {entries.map(([k, v]) => (
        <li key={k}>
          <div className="flex justify-between text-xs"><span>{k}</span><span className="tabular-nums text-muted">{((v / total) * 100).toFixed(0)}%</span></div>
          <div className="h-1.5 rounded bg-surface-2"><div className="h-full rounded bg-accent" style={{ width: `${(v / total) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

function Overview({ snapshot: s, onOpen }: { snapshot: Snapshot; onOpen: OpenEvidence }) {
  const findings = useAsync(() => api.findings(s.id), [s.id]);
  const deps = useAsync(() => api.dependencies(s.id), [s.id]);
  const a = s.analysis_summary;
  const inv = s.inventory_summary;
  const frameworks = findings.data?.filter((f) => f.kind === "framework") ?? [];
  const entries = findings.data?.filter((f) => f.kind === "entry_point") ?? [];
  const routes = findings.data?.filter((f) => f.kind === "route") ?? [];
  const openFinding = async (evidenceId: string | null) => {
    if (!evidenceId) return;
    const ev = await api.evidence(evidenceId);
    onOpen({ path: ev.path, start: ev.start_line, end: ev.end_line });
  };
  const warnings: string[] = [];
  if (s.coverage.is_partial) warnings.push(`Partial coverage: ${s.coverage.budget_skipped_files} eligible file(s) skipped by size/count limits.`);
  if ((a.stats?.files_with_parse_issues ?? 0) > 0) warnings.push(`${a.stats?.files_with_parse_issues} file(s) had parse errors.`);
  if ((a.evidence_rejected ?? 0) > 0) warnings.push(`${a.evidence_rejected} evidence candidate(s) were rejected during verification.`);

  return (
    <div className="space-y-5">
      {warnings.length > 0 ? (
        <div className="space-y-1 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-warn">{warnings.map((w) => <p key={w}>{w}</p>)}</div>
      ) : null}
      <div className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-surface p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Tracked files" value={s.coverage.tracked_files} />
        <Stat label="Analysed files" value={s.coverage.analyzed_files} />
        <Stat label="Analysed size" value={formatBytes(s.coverage.analyzed_bytes)} />
        <Stat label="Evidence records" value={a.evidence_records ?? 0} />
        <Stat label="Graph nodes" value={a.graph?.nodes ?? 0} />
        <Stat label="Graph edges" value={a.graph?.edges ?? 0} />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Languages (bytes)"><Bars data={inv.languages_by_bytes} /></Card>
        <Card title="File categories"><Bars data={inv.categories} /></Card>
        <Card title="Commit">
          <dl className="space-y-1.5 text-sm">
            <div><dt className="text-xs text-muted">SHA</dt><dd className="font-mono text-xs break-all">{s.commit_sha}</dd></div>
            <div><dt className="text-xs text-muted">Subject</dt><dd>{s.commit_info.subject ?? "—"}</dd></div>
            <div><dt className="text-xs text-muted">Author / date</dt><dd>{s.commit_info.author ?? "—"} · {formatTime(s.commit_info.date ?? null)}</dd></div>
            <div><dt className="text-xs text-muted">Acquired</dt><dd>{formatTime(s.acquired_at)}</dd></div>
          </dl>
        </Card>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Frameworks & technologies">
          {frameworks.length === 0 ? <Empty>No supported framework evidence found.</Empty> : (
            <ul className="space-y-1.5 text-sm">
              {frameworks.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-2">
                  <span>{f.name} <span className="text-xs text-muted">{String(f.detail.role ?? "")}</span></span>
                  <span className="flex items-center gap-2">
                    <Badge tone={f.confidence === "observed" ? "ok" : "accent"} title={f.confidence === "observed" ? "Imported in source" : "Declared in a manifest; no import observed"}>{f.confidence === "observed" ? "imported" : "declared only"}</Badge>
                    {f.evidence_id ? <button className="text-xs text-accent hover:underline" onClick={() => void openFinding(f.evidence_id)}>evidence</button> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={`Entry points & routes (${entries.length + routes.length})`}>
          {entries.length + routes.length === 0 ? <Empty>None detected.</Empty> : (
            <ul className="max-h-72 space-y-1 overflow-auto text-sm">
              {[...entries, ...routes].map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-2">
                  <span className="break-all"><Badge>{f.kind === "route" ? "route" : "entry"}</Badge> {f.name}</span>
                  {f.evidence_id ? <button className="shrink-0 text-xs text-accent hover:underline" onClick={() => void openFinding(f.evidence_id)}>evidence</button> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card title={`Dependencies (${deps.data?.length ?? 0})`}>
        {deps.error ? <ErrorBox error={deps.error} /> : null}
        {deps.data && deps.data.length === 0 ? <Empty>No dependency manifests parsed.</Empty> : null}
        {deps.data && deps.data.length > 0 ? (
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface text-left text-xs text-muted">
                <tr><th className="pb-2 font-medium">Package</th><th className="pb-2 font-medium">Scope</th><th className="pb-2 font-medium">Status</th><th className="pb-2 font-medium">Manifest</th><th /></tr>
              </thead>
              <tbody>
                {deps.data.map((d, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="py-1.5"><span className="text-xs text-muted">{d.ecosystem}</span> {d.name} <span className="text-xs text-muted">{d.specifier}</span></td>
                    <td className="py-1.5">{d.scope}</td>
                    <td className="py-1.5">
                      <Badge tone={d.status === "observed_import" ? "ok" : d.status === "undeclared_import" ? "warn" : "neutral"} title={d.status === "not_observed" ? "Not observed does not mean unused" : undefined}>
                        {d.status.replace("_", " ")}
                      </Badge>
                    </td>
                    <td className="py-1.5 font-mono text-xs text-muted">{d.manifest_path ?? "—"}</td>
                    <td className="py-1.5 text-right">{d.evidence_id ? <button className="text-xs text-accent hover:underline" onClick={() => void openFinding(d.evidence_id)}>evidence</button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      <Card title="Coverage & exclusions">
        <ul className="grid gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(s.coverage.exclusions).map(([k, v]) => <li key={k} className="flex justify-between gap-2"><span className="text-muted">{k}</span><span className="tabular-nums">{v}</span></li>)}
          {Object.keys(s.coverage.exclusions).length === 0 ? <Empty>No exclusions.</Empty> : null}
        </ul>
        <p className="mt-2 text-xs text-muted">Limits: {Object.entries(s.coverage.limits).map(([k, v]) => `${k}=${v}`).join(", ")}</p>
      </Card>
    </div>
  );
}

function Files({ snapshotId, onOpen }: { snapshotId: number; onOpen: (path: string) => void }) {
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const files = useAsync(() => api.files(snapshotId, { category: category || undefined, q: applied || undefined, limit: 500 }), [snapshotId, category, applied]);
  return (
    <Card title={`File inventory${files.data ? ` (${files.data.total})` : ""}`}>
      <div className="mb-3 flex flex-wrap gap-2 text-sm">
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-md border border-border bg-surface px-2 py-1.5">
          <option value="">All categories</option>
          {["source", "test", "documentation", "configuration", "dependency_manifest", "ci", "container", "binary", "generated", "dependency_vendor", "symlink", "submodule", "unsafe", "other"].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setApplied(query); }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="path contains…" className="rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs" />
          <Button type="submit" variant="secondary">Search</Button>
        </form>
      </div>
      {files.error ? <ErrorBox error={files.error} /> : null}
      {!files.data ? <Spinner /> : (
        <div className="max-h-[65vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface text-left text-xs text-muted">
              <tr><th className="pb-2 font-medium">Path</th><th className="pb-2 font-medium">Category</th><th className="pb-2 font-medium">Language</th><th className="pb-2 font-medium">Size</th><th className="pb-2 font-medium">Lines</th><th className="pb-2 font-medium">Status</th></tr>
            </thead>
            <tbody>
              {files.data.items.map((f) => (
                <tr key={f.path} className="border-t border-border">
                  <td className="py-1 font-mono text-xs break-all">{f.analyzed ? <button className="text-left text-accent hover:underline" onClick={() => onOpen(f.path)}>{f.path}</button> : f.path}</td>
                  <td className="py-1">{f.category}</td>
                  <td className="py-1 text-muted">{f.language ?? "—"}</td>
                  <td className="py-1 tabular-nums text-muted">{formatBytes(f.size)}</td>
                  <td className="py-1 tabular-nums text-muted">{f.line_count ?? "—"}</td>
                  <td className="py-1">{f.analyzed ? <Badge tone="ok">analysed</Badge> : <Badge tone="neutral" title="Excluded or not analysed">{f.exclusion_reason ?? "not analysed"}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {files.data.total > files.data.items.length ? <p className="mt-2 text-xs text-muted">Showing first {files.data.items.length} of {files.data.total}. Narrow with filters.</p> : null}
        </div>
      )}
    </Card>
  );
}

function Architecture({ snapshotId, onOpen }: { snapshotId: number; onOpen: OpenEvidence }) {
  const fileGraph = useAsync(() => api.graph(snapshotId, { view: "files", limit: 3000 }), [snapshotId]);
  const diagram = useMemo(() => (fileGraph.data ? componentDiagram(fileGraph.data.edges) : null), [fileGraph.data]);
  return (
    <div className="space-y-5">
      <Card title="Component diagram (directory groups, resolved imports only)">
        {fileGraph.error ? <ErrorBox error={fileGraph.error} /> : null}
        {!fileGraph.data ? <Spinner /> : diagram ? <MermaidDiagram definition={diagram} /> : <Empty>No resolved internal imports to diagram.</Empty>}
      </Card>
      <Card title="Repository graph explorer">
        <GraphExplorer snapshotId={snapshotId} onOpen={onOpen} />
      </Card>
    </div>
  );
}

function ReportTab({ snapshotId, onOpen }: { snapshotId: number; onOpen: OpenEvidence }) {
  const agent = useAsync(() => api.agentStatus(), []);
  const [selected, setSelected] = useState<number | null>(null);
  const [requestError, setRequestError] = useState<unknown>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const [polling, setPolling] = useState(false);
  const job = useAsync(() => (jobId ? api.job(jobId) : Promise.resolve(null)), [jobId], polling ? 2000 : null);
  const j = job.data && job.data.id === jobId ? job.data : null;
  const finished = j && (j.status === "succeeded" || j.status === "failed" || j.status === "cancelled") ? j : null;
  const working = jobId !== null && !finished;
  if (polling && finished) setPolling(false); // derived from fetched data, guarded so it runs once
  const reports = useAsync(() => api.reports(snapshotId), [snapshotId, finished?.id ?? 0]);
  const activeId = selected ?? reports.data?.[0]?.id ?? null;
  const report = useAsync(() => (activeId ? api.report(activeId) : Promise.resolve(null)), [activeId]);
  const jobError = finished && finished.status !== "succeeded" ? `${finished.error_code}: ${finished.error_message}` : null;

  async function requestAgent() {
    setRequestError(null);
    setSelected(null);
    try {
      const r = await api.requestAgentReport(snapshotId);
      setJobId(r.job.id);
      setPolling(true);
    } catch (e) {
      setRequestError(e);
    }
  }

  return (
    <div className="space-y-5">
      <Card title="Reports">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {reports.data?.map((r) => (
            <button key={r.id} onClick={() => setSelected(r.id)} className={`rounded-md border px-2.5 py-1 ${r.id === activeId ? "border-accent bg-accent-soft text-accent" : "border-border"}`}>
              #{r.id} {r.kind}{r.model ? ` · ${r.model}` : ""} · {formatTime(r.created_at)}
            </button>
          ))}
          <span className="flex-1" />
          <Button onClick={() => void requestAgent()} disabled={!agent.data?.agent_ready || working} title={agent.data?.agent_ready ? undefined : agent.data?.error ?? "Agent not ready"}>
            {working ? `Agent working… (${j?.stage ?? "queued"})` : "Generate agent report"}
          </Button>
        </div>
        {!agent.data?.agent_ready && agent.data ? <p className="mt-2 text-xs text-muted">Agent unavailable: {agent.data.error ?? "not ready"}. See <TextLink href="/settings">settings</TextLink>.</p> : null}
        {working ? <p className="mt-2 text-xs text-muted">Job <Link className="text-accent" href={`/jobs/${jobId}`}>#{jobId}</Link> is running; this can take a minute.</p> : null}
        <div className="mt-2"><ErrorBox error={requestError ?? jobError} /></div>
      </Card>
      {report.error ? <ErrorBox error={report.error} /> : null}
      {report.data ? <ReportView report={report.data} onOpen={onOpen} /> : reports.data?.length === 0 ? <Empty>No reports yet.</Empty> : <Spinner />}
    </div>
  );
}
