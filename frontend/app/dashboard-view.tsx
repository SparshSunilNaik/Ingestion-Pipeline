"use client";

import { Activity, Bot, Clock, Library, MessagesSquare, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api, recentConversations, type Repository } from "@/lib/api";
import { useAsync, useNow } from "@/lib/hooks";
import { SubmitRepository } from "@/components/submit-repository";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LanguageBar,
  Metric,
  Panel,
  ShortSha,
  SkeletonRows,
  StatusBadge,
  StatusDot,
  formatBytes,
  formatTime,
  timeAgo,
} from "@/components/ui";

export function DashboardView() {
  const repos = useAsync(() => api.repositories(), [], 8000);
  const jobs = useAsync(() => api.jobs(40), [], 4000);
  const agent = useAsync(() => api.agentStatus(), []);
  const convs = useAsync(() => recentConversations(8), []);
  const now = useNow();

  const allJobs = jobs.data ?? [];
  const running = allJobs.filter((j) => j.status === "running" || j.status === "queued").length;
  const failed = allJobs.filter((j) => j.status === "failed");
  const snapshots = (repos.data ?? []).reduce((a, r) => a + r.snapshots.filter((s) => s.status === "ready").length, 0);

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4 p-4">
      <div className="grid grid-cols-2 gap-4 rounded-lg border border-line bg-panel px-4 py-3 sm:grid-cols-3 lg:grid-cols-5">
        <Metric label="Repositories" value={repos.data ? repos.data.length : "—"} />
        <Metric label="Analysed snapshots" value={repos.data ? snapshots : "—"} />
        <Metric label="Jobs in progress" value={jobs.data ? running : "—"} tone={running ? "ok" : undefined} />
        <Metric label="Failed (last 40 jobs)" value={jobs.data ? failed.length : "—"} tone={failed.length ? "bad" : undefined} />
        <div className="min-w-0">
          <div className="text-[11px] tracking-wide text-fg-3 uppercase">Agent</div>
          <div className="mt-1 flex items-center gap-1.5 text-[12.5px]">
            <StatusDot tone={!agent.data ? "neutral" : agent.data.agent_ready ? "ok" : "warn"} />
            {agent.data ? (agent.data.agent_ready ? <span className="truncate font-mono">{agent.data.selected_model}</span> : <span className="text-warn">unavailable</span>) : "…"}
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Analyse a repository" icon={<Activity className="h-3.5 w-3.5" />}>
            <SubmitRepository />
          </Panel>
          <Panel title="Repositories" icon={<Library className="h-3.5 w-3.5" />} actions={<Link href="/repositories" className="text-[12px] text-accent hover:underline">All repositories</Link>} bodyClassName="p-0">
            {repos.error ? <div className="p-3"><ErrorState error={repos.error} onRetry={repos.reload} /></div> : null}
            {!repos.data && !repos.error && <div className="p-3"><SkeletonRows rows={5} /></div>}
            {repos.data && repos.data.length === 0 && <EmptyState icon={<Library className="h-6 w-6" />} title="No repositories analysed yet">Paste a public GitHub URL above to start your first analysis.</EmptyState>}
            {repos.data && repos.data.length > 0 && <RepoTable repos={repos.data.slice(0, 8)} now={now} onChanged={repos.reload} />}
          </Panel>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Recent analyses" icon={<Clock className="h-3.5 w-3.5" />} actions={<Link href="/jobs" className="text-[12px] text-accent hover:underline">All jobs</Link>} bodyClassName="p-0">
            {!jobs.data && <div className="p-3"><SkeletonRows rows={6} /></div>}
            {jobs.data && allJobs.length === 0 && <EmptyState title="No jobs yet" />}
            <ul className="divide-y divide-line">
              {allJobs.slice(0, 9).map((j) => (
                <li key={j.id}>
                  <Link href={`/jobs/${j.id}`} className="flex items-center gap-2.5 px-3 py-2 hover:bg-panel-2">
                    <StatusBadge status={j.status} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px]">{j.kind === "ingest" ? j.requested_url.replace("https://github.com/", "") : `${j.kind === "qa" ? "Question" : "Agent report"} · snapshot ${j.snapshot_id}`}</div>
                      <div className="truncate text-[11.5px] text-fg-3">{j.status === "failed" ? <span className="text-bad">{j.error_code}: {j.error_message}</span> : `${j.stage}${j.reused_cache ? " · cached" : ""}`}</div>
                    </div>
                    <span className="shrink-0 text-[11px] text-fg-3">{now ? timeAgo(j.created_at, now) : formatTime(j.created_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Recent investigations" icon={<MessagesSquare className="h-3.5 w-3.5" />} bodyClassName="p-0">
            {convs.error ? <div className="p-3"><ErrorState error={convs.error} compact /></div> : null}
            {convs.data && convs.data.length === 0 && <EmptyState icon={<Bot className="h-5 w-5" />} title="No investigations yet">Open a repository and ask a question in the Investigate view.</EmptyState>}
            <ul className="divide-y divide-line">
              {(convs.data ?? []).map((c) => (
                <li key={c.id}>
                  <Link href={`/snapshots/${c.snapshot_id}?view=investigate&c=${c.id}`} className="block px-3 py-2 hover:bg-panel-2">
                    <div className="truncate text-[12.5px]">{c.title}</div>
                    <div className="flex items-center gap-2 text-[11.5px] text-fg-3">
                      <span className="truncate">{c.repository}</span>
                      <ShortSha sha={c.commit_sha} />
                      <span>{c.questions} question{c.questions === 1 ? "" : "s"}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

export function RepoTable({ repos, now, onChanged }: { repos: Repository[]; now: number; onChanged: () => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  async function refresh(id: number) {
    setBusy(id);
    setError(null);
    try {
      await api.refreshRepository(id);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="overflow-x-auto">
      {error ? <div className="p-3"><ErrorState error={error} compact /></div> : null}
      <table className="w-full text-[12.5px]">
        <thead className="text-left text-[11px] tracking-wide text-fg-3 uppercase">
          <tr className="border-b border-line">
            <th className="px-3 py-2 font-medium">Repository</th>
            <th className="w-[26%] px-3 py-2 font-medium">Languages</th>
            <th className="px-3 py-2 font-medium">Coverage</th>
            <th className="px-3 py-2 font-medium">Commit</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {repos.map((r) => {
            const s = r.current_summary;
            const job = r.latest_job;
            const active = job && (job.status === "running" || job.status === "queued");
            return (
              <tr key={r.id} className="hover:bg-panel-2">
                <td className="px-3 py-2">
                  {r.current ? (
                    <Link href={`/snapshots/${r.current.id}`} className="font-medium hover:text-accent">
                      {r.owner}/{r.name}
                    </Link>
                  ) : (
                    <span className="font-medium">{r.owner}/{r.name}</span>
                  )}
                  <div className="text-[11.5px] text-fg-3">{r.current ? `analysed ${now ? timeAgo(r.current.acquired_at, now) : formatTime(r.current.acquired_at)}` : "no successful analysis"}</div>
                </td>
                <td className="px-3 py-2">{s ? <LanguageBar data={s.languages_by_bytes} height={5} /> : <span className="text-fg-3">—</span>}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {s ? (
                    <>
                      <span className="font-mono tabular-nums">{s.analyzed_files}/{s.tracked_files}</span> <span className="text-fg-3">files · {formatBytes(s.total_bytes)}</span>
                      {s.is_partial && <Badge tone="warn" className="ml-1.5">partial</Badge>}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2">{r.current ? <ShortSha sha={r.current.commit_sha} /> : "—"}</td>
                <td className="px-3 py-2">
                  {job ? (
                    <Link href={`/jobs/${job.id}`} title={job.error_message ?? undefined}>
                      <StatusBadge status={job.status} />
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button size="sm" variant="ghost" disabled={!!active || busy === r.id} onClick={() => refresh(r.id)} title="Re-check the remote HEAD and analyse if it changed">
                    <RefreshCw className={`h-3.5 w-3.5 ${busy === r.id || active ? "animate-spin" : ""}`} aria-hidden /> Refresh
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
