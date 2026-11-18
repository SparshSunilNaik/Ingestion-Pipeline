"use client";

import Link from "next/link";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { Badge, Button, Card, Empty, ErrorBox, ShortSha, Spinner, StatusBadge, TextLink, formatTime } from "@/components/ui";

export function DashboardView() {
  const repos = useAsync(() => api.repositories(), [], 5000);
  const jobs = useAsync(() => api.jobs(15), [], 3000);
  const agent = useAsync(() => api.agentStatus(), []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted">Analysed repositories, recent jobs and agent availability.</p>
        </div>
        <Link href="/submit">
          <Button>Analyze a repository</Button>
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Repositories" className="lg:col-span-2">
          {repos.error ? <ErrorBox error={repos.error} /> : null}
          {!repos.data && repos.loading ? <Spinner /> : null}
          {repos.data && repos.data.length === 0 ? <Empty>No repositories analysed yet.</Empty> : null}
          {repos.data && repos.data.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2 font-medium">Repository</th>
                  <th className="pb-2 font-medium">Current snapshot</th>
                  <th className="pb-2 font-medium">Snapshots</th>
                  <th className="pb-2 font-medium">Latest job</th>
                </tr>
              </thead>
              <tbody>
                {repos.data.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="py-2">
                      {r.current ? <TextLink href={`/snapshots/${r.current.id}`}>{`${r.owner}/${r.name}`}</TextLink> : `${r.owner}/${r.name}`}
                    </td>
                    <td className="py-2">{r.current ? <ShortSha sha={r.current.commit_sha} /> : <span className="text-muted">none</span>}</td>
                    <td className="py-2 tabular-nums">{r.snapshots.length}</td>
                    <td className="py-2">{r.latest_job ? <Link href={`/jobs/${r.latest_job.id}`}><StatusBadge status={r.latest_job.status} /></Link> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </Card>

        <Card title="Agent runtime" actions={<TextLink href="/settings">Settings</TextLink>}>
          {agent.error ? <ErrorBox error={agent.error} /> : null}
          {!agent.data && agent.loading ? <Spinner /> : null}
          {agent.data ? (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">OpenCode</dt>
                <dd>{agent.data.available ? <Badge tone="ok">connected {agent.data.version}</Badge> : <Badge tone="bad">unavailable</Badge>}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Model</dt>
                <dd className="truncate font-mono text-xs">{agent.data.selected_model}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Agent ready</dt>
                <dd>{agent.data.agent_ready ? <Badge tone="ok">yes</Badge> : <Badge tone="warn">no</Badge>}</dd>
              </div>
              {agent.data.error ? <p className="text-xs text-bad">{agent.data.error}</p> : null}
            </dl>
          ) : null}
        </Card>
      </div>

      <Card title="Recent jobs">
        {jobs.error ? <ErrorBox error={jobs.error} /> : null}
        {jobs.data && jobs.data.length === 0 ? <Empty>No jobs yet.</Empty> : null}
        {jobs.data && jobs.data.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="pb-2 font-medium">#</th>
                <th className="pb-2 font-medium">Kind</th>
                <th className="pb-2 font-medium">Target</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Stage</th>
                <th className="pb-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.map((j) => (
                <tr key={j.id} className="border-t border-border">
                  <td className="py-2"><TextLink href={`/jobs/${j.id}`}>{j.id}</TextLink></td>
                  <td className="py-2">{j.kind === "ingest" ? "ingestion" : "agent report"}</td>
                  <td className="max-w-xs truncate py-2 text-muted">{j.requested_url || `snapshot ${j.snapshot_id}`}</td>
                  <td className="py-2"><StatusBadge status={j.status} /> {j.reused_cache ? <Badge>cached</Badge> : null}</td>
                  <td className="py-2 text-muted">{j.stage}</td>
                  <td className="py-2 text-muted">{formatTime(j.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
    </div>
  );
}
