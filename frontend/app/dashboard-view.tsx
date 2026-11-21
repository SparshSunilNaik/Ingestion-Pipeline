"use client";

import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { type AgentStatus, api, recentConversations, type Repository } from "@/lib/api";
import { useAsync, useNow, usePref } from "@/lib/hooks";
import { HeroMap } from "@/components/atlas/hero-map";
import { SubmitRepository } from "@/components/submit-repository";
import { Badge, Button, ErrorState, LANG_COLORS, LanguageBar, ShortSha, SkeletonRows, StatusBadge, StatusDot, formatBytes, formatTime, timeAgo } from "@/components/ui";

export function DashboardView() {
  const repos = useAsync(() => api.repositories(), [], 8000);
  const jobs = useAsync(() => api.jobs(30), [], 3000);
  const agent = useAsync(() => api.agentStatus().catch(() => null), []);
  const ready = useAsync(() => api.ready().catch(() => null), [], 15000);
  const convs = useAsync(() => recentConversations(5).catch(() => []), []);
  const [lastSnapshot] = usePref("ip.lastSnapshot", "");
  const now = useNow();

  if (repos.error) return <div className="mx-auto max-w-[900px] p-6"><ErrorState error={repos.error} onRetry={repos.reload} /></div>;
  if (!repos.data) return <div className="mx-auto max-w-[900px] p-6"><SkeletonRows rows={8} /></div>;
  const allJobs = jobs.data ?? [];
  const inProgress = allJobs.filter((j) => j.status === "running" || j.status === "queued");
  const recentFailures = allJobs.filter((j) => j.status === "failed" && j.kind === "ingest").slice(0, 2);
  const withSnap = repos.data.filter((r) => r.current);
  const last = withSnap.flatMap((r) => r.snapshots.map((s) => ({ r, s }))).find(({ s }) => String(s.id) === lastSnapshot && s.status === "ready") ?? (withSnap[0]?.current ? { r: withSnap[0], s: withSnap[0].current } : null);
  const firstRun = repos.data.length === 0 && inProgress.length === 0;

  return (
    <div className="atlas-grid min-h-full">
      <div className="mx-auto max-w-[1280px] px-6 pt-12 pb-16 lg:px-10">
        <section className="grid items-center gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]" aria-labelledby="atlas-title">
          <div className="atlas-in">
            <div className="atlas-label flex items-center gap-2"><span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" aria-hidden /> code atlas · repository intelligence</div>
            <h1 id="atlas-title" className="atlas-display mt-4 text-[clamp(44px,5.4vw,76px)] text-fg">
              Explore software
              <br />
              like a <em className="text-accent">living system.</em>
            </h1>
            <p className="mt-5 max-w-[540px] text-[15px] leading-relaxed text-fg-2">
              Paste a public GitHub repository. Code Atlas maps its files, symbols, calls and routes from a pinned commit, traces how it runs, and answers questions with citations to the exact lines — all on this machine.
            </p>
            <div className="mt-7 max-w-[620px] rounded-xl border border-line bg-panel p-3 shadow-[var(--shadow)]">
              <SubmitRepository autoFocus={firstRun} />
              {firstRun && (
                <p className="px-1 text-[12px] text-fg-3">
                  Try <ExampleUrl url="https://github.com/pallets/itsdangerous" /> — small, about a minute.
                </p>
              )}
            </div>
            <EngineStatus agent={agent.data} worker={ready.data?.worker_running} />
            {last && (
              <Link href={`/snapshots/${last.s.id}`} className="group mt-6 inline-flex items-baseline gap-2 border-b border-line pb-1 hover:border-[var(--accent-line)]">
                <span className="atlas-label">resume</span>
                <span className="text-[14px] font-medium text-fg group-hover:text-accent">{last.r.owner}/{last.r.name}</span>
                <span className="font-mono text-[11px] text-fg-3">@ {last.s.commit_sha.slice(0, 7)} — your tabs are restored →</span>
              </Link>
            )}
          </div>
          <div className="atlas-fade relative hidden lg:block" style={{ animationDelay: "120ms" }}>
            <div className="pointer-events-none absolute inset-0 rounded-full bg-[radial-gradient(closest-side,var(--accent-soft),transparent)] opacity-60" aria-hidden />
            <HeroMap snapshotId={last?.s.id ?? null} caption={last ? `last explored · ${last.r.owner}/${last.r.name} @ ${last.s.commit_sha.slice(0, 10)} · real import map` : "your first map appears here"} />
          </div>
        </section>

        {(inProgress.length > 0 || recentFailures.length > 0) && (
          <section aria-label="Analyses in progress" className="mt-12 space-y-1.5">
            {inProgress.map((j) => (
              <Link key={j.id} href={`/jobs/${j.id}`} className="flex items-center gap-3 rounded-lg border border-[var(--accent-line)] bg-accent-soft px-4 py-2.5 hover:border-accent">
                <StatusBadge status={j.status} />
                <span className="min-w-0 truncate font-mono text-[13px]">{j.kind === "ingest" ? j.requested_url.replace("https://github.com/", "") : `${j.kind === "qa" ? "Question" : "AI report"} · snapshot ${j.snapshot_id}`}</span>
                <span className="truncate text-[12px] text-fg-2">{j.message ?? j.stage}</span>
                <span className="ml-auto shrink-0 font-mono text-[11.5px] text-accent">progress →</span>
              </Link>
            ))}
            {recentFailures.map((j) => (
              <Link key={j.id} href={`/jobs/${j.id}`} className="flex items-center gap-3 rounded-lg border border-bad/30 bg-bad-soft px-4 py-2 hover:border-bad">
                <StatusBadge status={j.status} />
                <span className="min-w-0 truncate font-mono text-[12.5px]">{j.requested_url.replace("https://github.com/", "")}</span>
                <span className="truncate text-[12px] text-fg-2">{j.error_message}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-fg-3">{now ? timeAgo(j.created_at, now) : ""}</span>
              </Link>
            ))}
          </section>
        )}

        {!firstRun && (
          <div className="mt-14 grid gap-10 lg:grid-cols-[minmax(0,1fr)_380px]">
            <section aria-labelledby="repos-heading" className="min-w-0">
              <div className="mb-3 flex items-baseline justify-between border-b border-line pb-2">
                <h2 id="repos-heading" className="atlas-label">recent repositories · {repos.data.length}</h2>
                <Link href="/repositories" className="font-mono text-[11px] text-fg-3 hover:text-accent">all →</Link>
              </div>
              <ul className="divide-y divide-line">
                {repos.data.slice(0, 8).map((r) => (
                  <li key={r.id}>
                    <RepoRow repo={r} now={now} />
                  </li>
                ))}
              </ul>
            </section>
            <aside className="min-w-0 space-y-10">
              <section aria-labelledby="inv-heading">
                <div className="mb-3 border-b border-line pb-2">
                  <h2 id="inv-heading" className="atlas-label">recent investigations</h2>
                </div>
                {convs.data && convs.data.length === 0 && <p className="text-[12.5px] text-fg-3">Questions you ask in a workspace are kept here, per commit.</p>}
                <ul className="space-y-3">
                  {(convs.data ?? []).map((c) => (
                    <li key={c.id}>
                      <Link href={`/snapshots/${c.snapshot_id}?view=overview&c=${c.id}`} className="group block">
                        <div className="line-clamp-2 text-[13px] text-fg group-hover:text-accent">{c.title}</div>
                        <div className="mt-0.5 font-mono text-[10.5px] text-fg-3">{c.repository} @ {c.commit_sha.slice(0, 7)} · {c.questions} question{c.questions === 1 ? "" : "s"}</div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            </aside>
          </div>
        )}

        {firstRun && (
          <ol className="mt-16 grid gap-8 border-t border-line pt-8 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Acquire safely", "A shallow clone of the exact commit. Hooks, submodules and LFS are off; nothing in the repository is ever run."],
              ["Map statically", "Python, TypeScript/JavaScript, Go and Java become symbols, imports, calls, inheritance, routes and dependencies."],
              ["Explore the map", "Follow the graph, trace execution, see what a change could reach — every fact links to its lines."],
              ["Ask with evidence", "The assistant answers from evidence the backend retrieves; each citation is re-verified against the commit."],
            ].map(([t, d], i) => (
              <li key={t}>
                <div className="font-mono text-[11px] text-accent">0{i + 1}</div>
                <div className="mt-1 text-[14px] font-semibold">{t}</div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-fg-3">{d}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function EngineStatus({ agent, worker }: { agent: AgentStatus | null | undefined; worker: boolean | undefined }) {
  return (
    <dl className="mt-5 flex flex-wrap gap-x-6 gap-y-1.5 font-mono text-[11px]">
      <div className="flex items-center gap-1.5">
        <dt className="text-fg-3">worker</dt>
        <dd className="flex items-center gap-1.5 text-fg-2"><StatusDot tone={worker === undefined ? "neutral" : worker ? "ok" : "warn"} />{worker === undefined ? "…" : worker ? "running" : "stopped"}</dd>
      </div>
      <div className="flex items-center gap-1.5">
        <dt className="text-fg-3">model</dt>
        <dd className="flex items-center gap-1.5 text-fg-2">
          <StatusDot tone={!agent ? "neutral" : agent.agent_ready ? "ok" : "warn"} />
          {agent ? (agent.agent_ready ? agent.selected_model : <Link href="/settings" className="text-warn underline-offset-2 hover:underline">unavailable — static analysis still works</Link>) : "…"}
        </dd>
      </div>
    </dl>
  );
}

function RepoRow({ repo: r, now }: { repo: Repository; now: number }) {
  const langs = Object.entries(r.current_summary?.languages_by_bytes ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return (
    <Link href={r.current ? `/snapshots/${r.current.id}` : `/jobs/${r.latest_job?.id ?? ""}`} className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 py-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <div className="truncate text-[14px] font-medium text-fg group-hover:text-accent">
          {r.owner}/<span className="font-semibold">{r.name}</span>
        </div>
        <div className="mt-0.5 font-mono text-[10.5px] text-fg-3">
          {r.current ? `${r.current.commit_sha.slice(0, 10)} · ${r.current_summary?.analyzed_files ?? "?"} files · analyzer ${r.current.analyzer_version}` : r.latest_job ? `${r.latest_job.status} · ${r.latest_job.stage}` : "not analysed"}
        </div>
      </div>
      <div className="hidden gap-3 font-mono text-[10.5px] text-fg-3 sm:flex">
        {langs.map(([l]) => (
          <span key={l} className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: LANG_COLORS[l] ?? "var(--fg-3)" }} aria-hidden />{l}</span>
        ))}
      </div>
      <div className="text-right font-mono text-[10.5px] text-fg-3">{now ? timeAgo(r.updated_at, now) : formatTime(r.updated_at)}</div>
    </Link>
  );
}

function ExampleUrl({ url }: { url: string }) {
  return (
    <button type="button" className="font-mono text-accent underline-offset-2 hover:underline" onClick={() => window.dispatchEvent(new CustomEvent("ip:fill-url", { detail: url }))}>
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
