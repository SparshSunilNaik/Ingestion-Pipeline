"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { Badge, Button, Card, ErrorBox, ProgressBar, Spinner, StatusBadge, formatTime } from "@/components/ui";

const STAGES = ["queued", "starting", "resolving", "cloning", "inventory", "analyzing", "reporting", "complete"];
const AGENT_STAGES = ["queued", "starting", "connecting", "investigating", "validating", "complete"];

export function JobView() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const job = useAsync(() => api.job(id), [id], 1500);
  const j = job.data;
  const active = j && (j.status === "queued" || j.status === "running");

  if (!j) return job.error ? <ErrorBox error={job.error} /> : <Spinner />;
  const stages = j.kind === "ingest" ? STAGES : AGENT_STAGES;
  const stageIdx = stages.indexOf(j.stage);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            {j.kind === "ingest" ? "Ingestion" : "Agent report"} job #{j.id}
          </h1>
          <p className="text-sm text-muted">{j.requested_url || `snapshot ${j.snapshot_id}`}</p>
        </div>
        <StatusBadge status={j.status} />
      </div>

      <Card>
        <div className="space-y-4">
          <ProgressBar value={j.progress} tone={j.status === "failed" ? "bad" : j.status === "succeeded" ? "ok" : "accent"} />
          <ol className="flex flex-wrap gap-2 text-xs">
            {stages.map((s, i) => (
              <li key={s}>
                <Badge tone={j.status === "failed" && i === stageIdx ? "bad" : i < stageIdx || j.status === "succeeded" ? "ok" : i === stageIdx ? "accent" : "neutral"}>{s}</Badge>
              </li>
            ))}
            {j.stage === "cached" ? <Badge tone="ok">cached</Badge> : null}
          </ol>
          {j.message ? <p className="text-sm">{j.message}</p> : null}
          {j.status === "failed" ? (
            <ErrorBox error={`${j.error_code ?? "error"}: ${j.error_message ?? "unknown error"}`} />
          ) : null}
          {j.reused_cache ? <p className="text-sm text-muted">The remote HEAD matched an already analysed commit; the cached snapshot was reused.</p> : null}
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div><dt className="text-xs text-muted">Created</dt><dd>{formatTime(j.created_at)}</dd></div>
            <div><dt className="text-xs text-muted">Started</dt><dd>{formatTime(j.started_at)}</dd></div>
            <div><dt className="text-xs text-muted">Finished</dt><dd>{formatTime(j.finished_at)}</dd></div>
            <div><dt className="text-xs text-muted">Attempts</dt><dd>{j.attempts}</dd></div>
          </dl>
          <div className="flex gap-2">
            {j.status === "succeeded" && j.snapshot_id ? (
              <Link href={`/snapshots/${j.snapshot_id}${j.kind === "agent_report" ? "?tab=report" : ""}`}>
                <Button>Open workspace</Button>
              </Link>
            ) : null}
            {active ? (
              <Button variant="secondary" onClick={() => api.cancelJob(j.id).then(job.reload).catch(() => undefined)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      </Card>
    </div>
  );
}
