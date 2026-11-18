"use client";

import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api, recentConversations, type Repository } from "@/lib/api";
import { useAsync, useNow, usePref } from "@/lib/hooks";
import { SubmitRepository } from "@/components/submit-repository";
import { Badge, Button, ErrorState, LanguageBar, ShortSha, SkeletonRows, StatusBadge, StatusDot, formatBytes, formatTime, timeAgo } from "@/components/ui";

export function DashboardView() {
  const repos = useAsync(() => api.repositories(), [], 8000);
  const jobs = useAsync(() => api.jobs(30), [], 3000);
  const agent = useAsync(() => api.agentStatus().catch(() => null), []);
  const convs = useAsync(() => recentConversations(6).catch(() => []), []);
  const [lastSnapshot] = usePref("ip.lastSnapshot", "");
  const now = useNow();

  if (repos.error) return <div className="mx-auto max-w-[900px] p-6"><ErrorState error={repos.error} onRetry={repos.reload} /></div>;
  if (!repos.data) return <div className="mx-auto max-w-[900px] p-6"><SkeletonRows rows={8} /></div>;
  const allJobs = jobs.data ?? [];
  const inProgress = allJobs.filter((j) => j.status === "running" || j.status === "queued");
  const recentFailures = allJobs.filter((j) => j.status === "failed" && j.kind === "ingest").slice(0, 3);
  const last = (repos.data ?? []).flatMap((r) => r.snapshots.map((s) => ({ r, s }))).find(({ s }) => String(s.id) === lastSnapshot && s.status === "ready");

  if (repos.data.length === 0 && inProgress.length === 0) return <FirstRun agentReady={!!agent.data?.agent_ready} model={agent.data?.selected_model} />;

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6 px-4 py-6">
      <section aria-labelledby="analyse-heading" className="rounded-xl border border-line bg-panel px-5 py-4">
        <h1 id="analyse-heading" className="text-[15px] font-semibold">Analyse a repository</h1>
        <p className="mt-0.5 mb-3 text-[12.5px] text-fg-3">Paste a public GitHub URL. Already-analysed commits open instantly from cache.</p>
        <SubmitRepository />
      </section>

      {(inProgress.length > 0 || recentFailures.length > 0) && (
        <section aria-label="Analyses in progress" className="space-y-1.5">
          {inProgress.map((j) => (
            <Link key={j.id} href={`/jobs/${j.id}`} className="flex items-center gap-3 rounded-lg border border-accent/30 bg-accent-soft px-4 py-2.5 hover:border-accent">
              <StatusBadge status={j.status} />
              <span className="min-w-0 truncate font-mono text-[13px]">{j.kind === "ingest" ? j.requested_url.replace("https://github.com/", "") : `${j.kind === "qa" ? "Question" : "AI report"} · snapshot ${j.snapshot_id}`}</span>
              <span className="truncate text-[12px] text-fg-2">{j.message ?? j.stage}</span>
              <span className="ml-auto shrink-0 text-[12px] text-accent">View progress →</span>
            </Link>
          ))}
          {recentFailures.map((j) => (
            <Link key={j.id} href={`/jobs/${j.id}`} className="flex items-center gap-3 rounded-lg border border-bad/30 bg-bad-soft px-4 py-2 hover:border-bad">
              <StatusBadge status={j.status} />
              <span className="min-w-0 truncate font-mono text-[12.5px]">{j.requested_url.replace("https://github.com/", "")}</span>
              <span className="truncate text-[12px] text-fg-2">{j.error_message}</span>
              <span className="ml-auto shrink-0 text-[11.5px] text-fg-3">{now ? timeAgo(j.created_at, now) : ""}</span>
            </Link>
          ))}
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section aria-labelledby="repos-heading" className="min-w-0">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 id="repos-heading" className="text-[13px] font-semibold">Repositories</h2>
            <Link href="/repositories" className="text-[12px] text-accent hover:underline">All repositories</Link>
          </div>
          <div className="overflow-hidden rounded-xl border border-line bg-panel">
            <RepoTable repos={repos.data.slice(0, 10)} now={now} onChanged={repos.reload} />
          </div>
        </section>
        <aside className="flex min-w-0 flex-col gap-6">
          {last && (
            <section aria-labelledby="continue-heading">
              <h2 id="continue-heading" className="mb-2 text-[13px] font-semibold">Continue where you left off</h2>
              <Link href={`/snapshots/${last.s.id}`} className="block rounded-xl border border-line bg-panel px-4 py-3 hover:border-accent">
                <div className="truncate text-[14px] font-semibold">{last.r.owner}/{last.r.name}</div>
                <div className="mt-1 flex items-center gap-2 text-[12px] text-fg-3">
                  <ShortSha sha={last.s.commit_sha} /> analysed {formatTime(last.s.acquired_at)}
                </div>
                <div className="mt-2 text-[12.5px] text-accent">Reopen workspace — your open tabs are restored →</div>
              </Link>
            </section>
          )}
          <section aria-labelledby="inv-heading">
            <h2 id="inv-heading" className="mb-2 text-[13px] font-semibold">Recent investigations</h2>
            {convs.data && convs.data.length === 0 && (
              <p className="rounded-xl border border-dashed border-line px-4 py-3 text-[12.5px] text-fg-3">Questions you ask the assistant in a workspace are saved here, per commit.</p>
            )}
            <ul className="space-y-1.5">
              {(convs.data ?? []).map((c) => (
                <li key={c.id}>
                  <Link href={`/snapshots/${c.snapshot_id}?view=overview&c=${c.id}`} className="block rounded-lg border border-line bg-panel px-3 py-2 hover:border-accent">
                    <div className="truncate text-[12.5px]">{c.title}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-fg-3">
                      <span className="truncate">{c.repository}</span>
                      <ShortSha sha={c.commit_sha} />
                      <span className="shrink-0">{c.questions} question{c.questions === 1 ? "" : "s"}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          <section className="text-[12px] text-fg-3">
            <div className="flex items-center gap-1.5">
              <StatusDot tone={!agent.data ? "neutral" : agent.data.agent_ready ? "ok" : "warn"} />
              {agent.data?.agent_ready ? (
                <span>AI assistant ready · <span className="font-mono">{agent.data.selected_model}</span></span>
              ) : (
                <span>AI assistant unavailable — static analysis still works. <Link href="/settings" className="underline">Settings</Link></span>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function FirstRun({ agentReady, model }: { agentReady: boolean; model?: string }) {
  const steps = [
    { title: "Acquire safely", text: "A shallow clone of the exact commit. Hooks, submodules and LFS are disabled; nothing in the repository is ever executed." },
    { title: "Analyse statically", text: "Python, TypeScript/JavaScript, Go and Java are parsed into symbols, imports, calls, inheritance, routes and dependencies." },
    { title: "Explore with evidence", text: "Browse the architecture, trace execution, check what a change could affect — every fact links to exact source lines." },
    { title: "Ask questions", text: "An AI assistant answers from evidence the backend retrieves, and every citation is verified against the commit." },
  ];
  return (
    <div className="mx-auto flex min-h-full max-w-[860px] flex-col justify-center px-6 py-12">
      <h1 className="text-[28px] leading-tight font-semibold tracking-tight">Understand any GitHub repository.</h1>
      <p className="mt-3 max-w-[640px] text-[15px] leading-relaxed text-fg-2">
        Paste a public repository and get an evidence-backed map of what it does, how it is built and how its code connects — then ask questions about it. Everything runs on this machine.
      </p>
      <div className="mt-7 rounded-xl border border-line bg-panel p-4 shadow-sm">
        <SubmitRepository autoFocus />
        <p className="mt-1 text-[12px] text-fg-3">
          Try <ExampleUrl url="https://github.com/pallets/itsdangerous" /> (small, about a minute).
        </p>
      </div>
      <ol className="mt-10 grid gap-5 sm:grid-cols-2">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent">{i + 1}</span>
            <div>
              <div className="text-[13.5px] font-semibold">{s.title}</div>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-3">{s.text}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-10 flex items-center gap-1.5 text-[12px] text-fg-3">
        <StatusDot tone={agentReady ? "ok" : "warn"} />
        {agentReady ? <>AI assistant ready with <span className="font-mono">{model}</span>.</> : <>The AI assistant is not available right now; analysis and exploration work without it. <Link href="/settings" className="underline">Settings</Link></>}
      </p>
    </div>
  );
}

function ExampleUrl({ url }: { url: string }) {
  return (
    <button
      type="button"
      className="font-mono text-accent hover:underline"
      onClick={() => window.dispatchEvent(new CustomEvent("ip:fill-url", { detail: url }))}
    >
      {url.replace("https://github.com/", "")}
    </button>
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
