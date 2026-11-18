"use client";

import { Boxes, FileCode, GitCompare, MessagesSquare, Network, RefreshCw, ScrollText } from "lucide-react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo } from "react";
import { api } from "@/lib/api";
import { useAsync, useHotkey, writePref } from "@/lib/hooks";
import { Architecture } from "@/components/workspace/architecture";
import { CodeExplorer } from "@/components/workspace/code-explorer";
import { Compare } from "@/components/workspace/compare";
import { Investigate } from "@/components/workspace/investigate";
import { NavContext, type View, type WorkspaceNav, getEvidence } from "@/components/workspace/nav";
import { Overview } from "@/components/workspace/overview";
import { ReportPanel } from "@/components/workspace/report";
import { Button, ErrorState, Spinner, cn } from "@/components/ui";

const VIEWS: { id: View; label: string; icon: typeof Boxes }[] = [
  { id: "overview", label: "Overview", icon: Boxes },
  { id: "code", label: "Code", icon: FileCode },
  { id: "architecture", label: "Architecture", icon: Network },
  { id: "investigate", label: "Investigate", icon: MessagesSquare },
  { id: "report", label: "Report", icon: ScrollText },
  { id: "compare", label: "Compare", icon: GitCompare },
];

export function WorkspaceView() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const view = (VIEWS.some((v) => v.id === search.get("view")) ? search.get("view") : "overview") as View;
  const snap = useAsync(() => api.snapshot(id), [id]);

  useEffect(() => {
    if (snap.data) writePref("ip.lastSnapshot", String(snap.data.id));
  }, [snap.data]);

  const setParams = useCallback(
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

  const nav = useMemo<WorkspaceNav>(
    () => ({
      snapshotId: id,
      view,
      setView: (v) => setParams({ view: v }),
      openSource: ({ path, start, end, sym }) =>
        setParams({ view: "code", file: path, l: start ? `${start}-${end ?? start}` : null, sym: sym ?? null }),
      openEvidence: async (eid) => {
        const ev = await getEvidence(eid);
        setParams({ view: "code", file: ev.path, l: `${ev.start_line}-${ev.end_line}`, sym: null });
      },
      focusGraph: (key, tab) => setParams({ view: "architecture", gview: "focus", focus: key, tab: tab ?? null }),
      ask: (question) => setParams({ view: "investigate", q: question }),
      param: (name) => search.get(name),
      setParams,
    }),
    [id, view, setParams, search],
  );

  useHotkey("alt+1", () => nav.setView("overview"));
  useHotkey("alt+2", () => nav.setView("code"));
  useHotkey("alt+3", () => nav.setView("architecture"));
  useHotkey("alt+4", () => nav.setView("investigate"));
  useHotkey("alt+5", () => nav.setView("report"));
  useHotkey("alt+6", () => nav.setView("compare"));

  if (snap.error) return <div className="p-6"><ErrorState error={snap.error} onRetry={snap.reload} /></div>;
  if (!snap.data) return <div className="p-6"><Spinner label="Loading workspace" /></div>;
  const s = snap.data;

  return (
    <NavContext.Provider value={nav}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-panel px-3" role="tablist" aria-label="Workspace views">
          {VIEWS.map((v, i) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={view === v.id}
              title={`${v.label} (Alt+${i + 1})`}
              onClick={() => nav.setView(v.id)}
              className={cn(
                "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors",
                view === v.id ? "bg-panel-3 text-fg" : "text-fg-3 hover:bg-panel-2 hover:text-fg",
              )}
            >
              <v.icon className="h-3.5 w-3.5" aria-hidden />
              {v.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1.5">
            <RefreshButton repositoryId={s.repository.id} />
          </div>
        </div>
        <div className="min-h-0 flex-1">
          {view === "overview" && <Overview snapshot={s} />}
          {view === "code" && <CodeExplorer snapshot={s} />}
          {view === "architecture" && <Architecture snapshot={s} />}
          {view === "investigate" && <Investigate snapshot={s} />}
          {view === "report" && <ReportPanel snapshot={s} />}
          {view === "compare" && <Compare snapshot={s} />}
        </div>
      </div>
    </NavContext.Provider>
  );
}

function RefreshButton({ repositoryId }: { repositoryId: number }) {
  const router = useRouter();
  return (
    <Button
      size="sm"
      variant="ghost"
      title="Re-check the remote HEAD; a changed commit is analysed incrementally into a new snapshot"
      onClick={() => api.refreshRepository(repositoryId).then((r) => router.push(`/jobs/${r.job.id}`))}
    >
      <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh analysis
    </Button>
  );
}
