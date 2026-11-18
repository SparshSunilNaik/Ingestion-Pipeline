"use client";

import { GitCompare, Library } from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAsync, useNow } from "@/lib/hooks";
import { RepoTable } from "@/app/dashboard-view";
import { SubmitRepository } from "@/components/submit-repository";
import { Badge, EmptyState, ErrorState, Panel, ShortSha, SkeletonRows, formatTime } from "@/components/ui";

export default function RepositoriesPage() {
  const repos = useAsync(() => api.repositories(), [], 8000);
  const now = useNow();
  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4 p-4">
      <Panel title="Analyse a repository">
        <SubmitRepository />
      </Panel>
      <Panel title="Repositories" icon={<Library className="h-3.5 w-3.5" />} bodyClassName="p-0">
        {repos.error ? <div className="p-3"><ErrorState error={repos.error} onRetry={repos.reload} /></div> : null}
        {!repos.data && !repos.error && <div className="p-3"><SkeletonRows /></div>}
        {repos.data?.length === 0 && <EmptyState title="No repositories yet" />}
        {repos.data && repos.data.length > 0 && <RepoTable repos={repos.data} now={now} onChanged={repos.reload} />}
      </Panel>
      {(repos.data ?? []).map((r) => (
        <Panel key={r.id} title={`${r.owner}/${r.name} · snapshot history`} bodyClassName="p-0">
          <table className="w-full text-[12.5px]">
            <thead className="text-left text-[11px] tracking-wide text-fg-3 uppercase">
              <tr className="border-b border-line">
                <th className="px-3 py-1.5 font-medium">Snapshot</th>
                <th className="px-3 py-1.5 font-medium">Commit</th>
                <th className="px-3 py-1.5 font-medium">Analyzer</th>
                <th className="px-3 py-1.5 font-medium">Acquired</th>
                <th className="px-3 py-1.5 font-medium">Status</th>
                <th className="px-3 py-1.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {r.snapshots.map((s, i) => {
                const older = r.snapshots[i + 1];
                return (
                  <tr key={s.id} className="hover:bg-panel-2">
                    <td className="px-3 py-1.5">
                      <Link href={`/snapshots/${s.id}`} className="hover:text-accent">#{s.id}</Link>
                      {s.id === r.current_snapshot_id && <Badge tone="accent" className="ml-2">current</Badge>}
                    </td>
                    <td className="px-3 py-1.5"><ShortSha sha={s.commit_sha} /></td>
                    <td className="px-3 py-1.5 font-mono text-[11.5px] text-fg-2">{s.analyzer_version}</td>
                    <td className="px-3 py-1.5 text-fg-2">{formatTime(s.acquired_at)}</td>
                    <td className="px-3 py-1.5"><Badge tone={s.status === "ready" ? "ok" : "warn"}>{s.status}</Badge></td>
                    <td className="px-3 py-1.5 text-right">
                      {older && s.status === "ready" && older.status === "ready" && (
                        <Link href={`/snapshots/${s.id}?view=compare&base=${older.id}`} className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline">
                          <GitCompare className="h-3.5 w-3.5" aria-hidden /> Compare with #{older.id}
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      ))}
    </div>
  );
}
