"use client";

import { Clock } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api, type JobStatus } from "@/lib/api";
import { useAsync, useNow } from "@/lib/hooks";
import { EmptyState, ErrorState, Panel, Segmented, SkeletonRows, StatusBadge, formatTime, timeAgo } from "@/components/ui";

type Filter = "all" | "active" | "failed";

export default function JobsPage() {
  const jobs = useAsync(() => api.jobs(100), [], 3000);
  const [filter, setFilter] = useState<Filter>("all");
  const now = useNow();
  const rows = (jobs.data ?? []).filter((j) => filter === "all" || (filter === "failed" ? j.status === "failed" : (["queued", "running"] as JobStatus[]).includes(j.status)));
  return (
    <div className="mx-auto max-w-[1500px] p-4">
      <Panel
        title="Recent analyses"
        icon={<Clock className="h-3.5 w-3.5" />}
        actions={<Segmented label="Filter jobs" value={filter} onChange={setFilter} options={[{ id: "all", label: "All" }, { id: "active", label: "Active" }, { id: "failed", label: "Failed" }]} />}
        bodyClassName="p-0"
      >
        {jobs.error ? <div className="p-3"><ErrorState error={jobs.error} onRetry={jobs.reload} /></div> : null}
        {!jobs.data && !jobs.error && <div className="p-3"><SkeletonRows rows={8} /></div>}
        {jobs.data && rows.length === 0 && <EmptyState title="No jobs match this filter" />}
        {rows.length > 0 && (
          <table className="w-full text-[12.5px]">
            <thead className="text-left text-[11px] tracking-wide text-fg-3 uppercase">
              <tr className="border-b border-line">
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Stage / error</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Attempts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((j) => (
                <tr key={j.id} className="hover:bg-panel-2">
                  <td className="px-3 py-1.5 font-mono"><Link href={`/jobs/${j.id}`} className="text-accent hover:underline">{j.id}</Link></td>
                  <td className="px-3 py-1.5">{{ ingest: "ingestion", agent_report: "agent report", qa: "question", selftest: "self-test" }[j.kind]}</td>
                  <td className="max-w-[320px] truncate px-3 py-1.5 text-fg-2">{j.requested_url || `snapshot ${j.snapshot_id}`}</td>
                  <td className="px-3 py-1.5"><StatusBadge status={j.status} /></td>
                  <td className="max-w-[360px] truncate px-3 py-1.5 text-fg-2" title={j.error_message ?? undefined}>
                    {j.status === "failed" ? <span className="text-bad">{j.error_code}: {j.error_message}</span> : `${j.stage}${j.reused_cache ? " (cached)" : ""}`}
                  </td>
                  <td className="px-3 py-1.5 text-fg-3">{now ? timeAgo(j.created_at, now) : formatTime(j.created_at)}</td>
                  <td className="px-3 py-1.5 font-mono text-fg-3">{j.attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
