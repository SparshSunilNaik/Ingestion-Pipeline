"use client";

import { ArrowRight, Check, CircleX, LoaderCircle, RotateCcw, Square } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type Job } from "@/lib/api";
import { useAsync, useNow } from "@/lib/hooks";
import { Button, ErrorState, Spinner, StatusBadge, cn, formatTime } from "@/components/ui";

interface Stage {
  id: string;
  label: string;
  detail: string;
  /** Older backends reported these stage names for the same step. */
  aliases?: string[];
}

const INGEST: Stage[] = [
  { id: "queued", label: "Waiting for the worker", detail: "The job is queued; the analysis worker picks it up in order.", aliases: ["requeued"] },
  { id: "resolving", label: "Connecting to GitHub", detail: "Resolving the default branch and its exact commit SHA.", aliases: ["starting"] },
  { id: "cloning", label: "Acquiring the repository", detail: "Shallow, hardened clone: no hooks, no submodules, no LFS, nothing executed." },
  { id: "inventory", label: "Indexing files", detail: "Classifying every tracked file and choosing what to analyse within the limits." },
  { id: "symbols", label: "Extracting symbols", detail: "Parsing source files into functions, classes, imports and calls.", aliases: ["analyzing"] },
  { id: "relationships", label: "Resolving relationships", detail: "Connecting imports, inheritance and call sites across files." },
  { id: "architecture", label: "Building the architecture", detail: "Assembling the graph and verifying an evidence record for every fact." },
  { id: "reporting", label: "Preparing the intelligence report", detail: "Writing the evidence-grounded overview." },
];
const AGENT: Stage[] = [
  { id: "queued", label: "Waiting for the worker", detail: "" },
  { id: "connecting", label: "Connecting to the model", detail: "Checking that OpenCode and the configured model are available.", aliases: ["starting"] },
  { id: "investigating", label: "Investigating", detail: "The model reads evidence the backend retrieves; it has no tools." },
  { id: "validating", label: "Validating citations", detail: "Every cited evidence ID is re-verified against the snapshot." },
];

function stageIndex(stages: Stage[], job: Job): number {
  if (job.status === "succeeded" || job.stage === "complete" || job.stage === "cached") return stages.length;
  const i = stages.findIndex((s) => s.id === job.stage || s.aliases?.includes(job.stage));
  return i === -1 ? 0 : i;
}

const FAILURE_HELP: Record<string, string> = {
  invalid_repository_url: "Use the root URL of a public github.com repository, e.g. https://github.com/owner/name.",
  acquisition_failed: "GitHub could not be reached, or the repository is private, renamed or empty. Check the URL and your network connection.",
  limit_exceeded: "The repository exceeds a configured limit (size, file count or clone time). See docs/WINDOWS_SETUP.md for the IP_LIMIT_* settings.",
  unsafe_content: "The repository contains content the safety checks refuse to process (for example unsafe paths).",
  cancelled: "The analysis was cancelled. Nothing was changed; any earlier snapshot is still available.",
  interrupted: "The analysis was interrupted (for example the backend restarted) and could not be resumed.",
  worker_crash: "The analysis process stopped unexpectedly. Retrying usually works; details are in the backend log.",
  timeout: "The analysis exceeded its time limit and was stopped.",
};

export function JobView() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = Number(params.id);
  const [poll, setPoll] = useState(true);
  const job = useAsync(() => api.job(id), [id], poll ? 1200 : null);
  const j = job.data;
  const now = useNow();
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const active = !!j && (j.status === "queued" || j.status === "running");
  if (j && poll !== active) setPoll(active);

  // A finished ingestion opens the workspace directly.
  useEffect(() => {
    if (j?.status === "succeeded" && j.kind === "ingest" && j.snapshot_id) {
      const t = setTimeout(() => router.push(`/snapshots/${j.snapshot_id}`), 900);
      return () => clearTimeout(t);
    }
  }, [j?.status, j?.kind, j?.snapshot_id, router]);

  if (!j) return <div className="p-6">{job.error ? <ErrorState error={job.error} onRetry={job.reload} /> : <Spinner label="Loading analysis" />}</div>;
  const stages = j.kind === "agent_report" ? AGENT : INGEST;
  const idx = stageIndex(stages, j);
  const failed = j.status === "failed" || j.status === "cancelled";
  const started = j.started_at ? new Date(j.started_at).getTime() : null;
  const end = j.finished_at ? new Date(j.finished_at).getTime() : now;
  const elapsed = started && end ? Math.max(0, Math.round((end - started) / 1000)) : null;
  const repo = j.requested_url.replace("https://github.com/", "");

  async function retry() {
    setRetrying(true);
    setActionError(null);
    try {
      const r = j && j.kind === "ingest" ? await api.createJob(j.requested_url) : null;
      if (r) router.push(`/jobs/${r.job.id}`);
    } catch (e) {
      setActionError(e);
      setRetrying(false);
    }
  }

  return (
    <div className="mx-auto max-w-[720px] px-4 py-10">
      <div className="mb-6">
        <div className="text-[12px] tracking-wide text-fg-3 uppercase">{j.kind === "ingest" ? "Analysing repository" : j.kind === "agent_report" ? "AI technical report" : "Question"}</div>
        <h1 className="mt-1 truncate font-mono text-[20px] font-semibold">{repo || `snapshot ${j.snapshot_id}`}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-fg-3">
          <StatusBadge status={j.status} />
          <span>job #{j.id}</span>
          <span>· started {formatTime(j.started_at ?? j.created_at)}</span>
          {elapsed !== null && <span>· {elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}</span>}
          {j.attempts > 1 && <span>· attempt {j.attempts}</span>}
        </div>
      </div>

      {j.reused_cache && j.status === "succeeded" && (
        <p className="mb-4 rounded-md border border-line bg-panel px-3 py-2 text-[13px] text-fg-2">
          This commit was already analysed, so the existing snapshot was reused — no new clone was needed.
        </p>
      )}

      <ol className="space-y-0" aria-label="Analysis stages">
        {stages.map((s, i) => {
          const done = i < idx;
          const current = i === idx && active;
          const failedHere = failed && i === Math.min(idx, stages.length - 1);
          return (
            <li key={s.id} className="flex gap-3" aria-current={current ? "step" : undefined}>
              <div className="flex flex-col items-center">
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
                    failedHere ? "border-bad bg-bad-soft text-bad" : done ? "border-ok bg-ok-soft text-ok" : current ? "border-accent bg-accent-soft text-accent" : "border-line text-fg-3",
                  )}
                >
                  {failedHere ? <CircleX className="h-3.5 w-3.5" aria-hidden /> : done ? <Check className="h-3.5 w-3.5" aria-hidden /> : current ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <span className="text-[10px]">{i + 1}</span>}
                </span>
                {i < stages.length - 1 && <span className={cn("my-0.5 w-px flex-1", done ? "bg-ok/50" : "bg-line")} style={{ minHeight: 14 }} />}
              </div>
              <div className="pb-3">
                <div className={cn("text-[13.5px]", current || failedHere ? "font-semibold text-fg" : done ? "text-fg-2" : "text-fg-3")}>{s.label}</div>
                {(current || failedHere) && <div className="mt-0.5 text-[12.5px] text-fg-2">{current && j.message ? j.message : s.detail}</div>}
              </div>
            </li>
          );
        })}
      </ol>

      {j.status === "succeeded" && (
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-ok/30 bg-ok-soft px-4 py-3">
          <Check className="h-4 w-4 text-ok" aria-hidden />
          <span className="text-[13px]">Analysis complete. Opening the workspace…</span>
          {j.snapshot_id && (
            <Link href={`/snapshots/${j.snapshot_id}${j.kind === "agent_report" ? "?view=report" : ""}`} className="ml-auto">
              <Button variant="primary">Open workspace <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Button>
            </Link>
          )}
        </div>
      )}

      {failed && (
        <div className="mt-4 space-y-3 rounded-lg border border-bad/30 bg-bad-soft px-4 py-3">
          <div className="text-[13.5px] font-semibold text-bad">{j.status === "cancelled" ? "Analysis cancelled" : "Analysis failed"}</div>
          {j.error_message && j.status !== "cancelled" && <p className="font-mono text-[12px] break-words text-fg-2">{j.error_code}: {j.error_message}</p>}
          <p className="text-[12.5px] text-fg-2">{FAILURE_HELP[j.error_code ?? (j.status === "cancelled" ? "cancelled" : "")] ?? "Retrying is safe: a failed analysis never replaces an earlier snapshot."}</p>
          <div className="flex flex-wrap gap-2">
            {j.kind === "ingest" && j.requested_url && (
              <Button variant="primary" onClick={retry} disabled={retrying}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden /> {retrying ? "Starting…" : "Try again"}
              </Button>
            )}
            <Link href="/"><Button>Back to start</Button></Link>
          </div>
          <ErrorState error={actionError} compact />
        </div>
      )}

      {active && (
        <div className="mt-4 flex items-center gap-3">
          <Button variant="danger" onClick={() => api.cancelJob(j.id).then(job.reload, setActionError)}>
            <Square className="h-3.5 w-3.5" aria-hidden /> Cancel analysis
          </Button>
          <span className="text-[12px] text-fg-3">You can leave this page; the analysis continues in the background.</span>
          <ErrorState error={actionError} compact />
        </div>
      )}
    </div>
  );
}
