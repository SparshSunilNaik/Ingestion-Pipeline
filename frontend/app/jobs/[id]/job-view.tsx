"use client";

import { ArrowRight, Square } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { Button, ErrorState, Panel, Spinner, StatusBadge, cn, formatTime } from "@/components/ui";

const STAGES: Record<string, string[]> = {
  ingest: ["queued", "starting", "resolving", "cloning", "inventory", "analyzing", "reporting", "complete"],
  agent_report: ["queued", "starting", "connecting", "investigating", "validating", "complete"],
  qa: ["queued", "starting", "retrieving", "investigating", "complete"],
};

export function JobView() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const job = useAsync(() => api.job(id), [id], 1500);
  const j = job.data;
  if (!j) return <div className="p-6">{job.error ? <ErrorState error={job.error} /> : <Spinner label="Loading job" />}</div>;
  const stages = STAGES[j.kind] ?? ["queued", "complete"];
  const idx = j.stage === "cached" ? stages.length - 1 : stages.indexOf(j.stage);
  const active = j.status === "queued" || j.status === "running";
  return (
    <div className="mx-auto max-w-[860px] p-4">
      <Panel
        title={`${j.kind === "ingest" ? "Ingestion" : j.kind === "qa" ? "Question" : "Agent report"} job #${j.id}`}
        actions={<StatusBadge status={j.status} />}
      >
        <div className="space-y-4">
          <div className="truncate font-mono text-[12.5px] text-fg-2">{j.requested_url || `snapshot ${j.snapshot_id}`}</div>
          <div className="h-1.5 overflow-hidden rounded-full bg-panel-3" role="progressbar" aria-valuenow={j.progress} aria-valuemin={0} aria-valuemax={100}>
            <div className={cn("h-full transition-all", j.status === "failed" ? "bg-bad" : j.status === "succeeded" ? "bg-ok" : "bg-accent")} style={{ width: `${j.progress}%` }} />
          </div>
          <ol className="flex flex-wrap items-center gap-1.5 text-[11.5px]" aria-label="Stages">
            {stages.map((s, i) => {
              const done = j.status === "succeeded" || i < idx;
              const current = i === idx && active;
              const failedHere = j.status === "failed" && i === Math.max(idx, 0);
              return (
                <li key={s} className="flex items-center gap-1.5">
                  <span className={cn("rounded px-1.5 py-0.5", failedHere ? "bg-bad-soft text-bad" : done ? "bg-ok-soft text-ok" : current ? "bg-accent-soft text-accent" : "bg-panel-3 text-fg-3")}>{s}</span>
                  {i < stages.length - 1 && <ArrowRight className="h-3 w-3 text-fg-3" aria-hidden />}
                </li>
              );
            })}
          </ol>
          {j.message && <p className="text-[12.5px] text-fg-2">{j.message}</p>}
          {j.reused_cache && <p className="text-[12.5px] text-fg-2">The remote HEAD matched an already-analysed commit; the cached snapshot was reused.</p>}
          {j.status === "failed" && <ErrorState error={`${j.error_code ?? "error"}: ${j.error_message ?? "unknown error"}`} />}
          <dl className="grid grid-cols-2 gap-3 text-[12.5px] sm:grid-cols-4">
            <div><dt className="text-[11px] text-fg-3 uppercase">Created</dt><dd>{formatTime(j.created_at)}</dd></div>
            <div><dt className="text-[11px] text-fg-3 uppercase">Started</dt><dd>{formatTime(j.started_at)}</dd></div>
            <div><dt className="text-[11px] text-fg-3 uppercase">Finished</dt><dd>{formatTime(j.finished_at)}</dd></div>
            <div><dt className="text-[11px] text-fg-3 uppercase">Attempts</dt><dd className="font-mono">{j.attempts}</dd></div>
          </dl>
          <div className="flex gap-2">
            {j.status === "succeeded" && j.snapshot_id && (
              <Link href={`/snapshots/${j.snapshot_id}${j.kind === "agent_report" ? "?view=report" : j.kind === "qa" ? "?view=investigate" : ""}`}>
                <Button variant="primary">Open workspace <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Button>
              </Link>
            )}
            {active && (
              <Button variant="danger" onClick={() => api.cancelJob(j.id).then(job.reload).catch(() => undefined)}>
                <Square className="h-3.5 w-3.5" aria-hidden /> Cancel
              </Button>
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}
