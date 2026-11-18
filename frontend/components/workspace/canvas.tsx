"use client";

import { Boxes, Braces, FileCode, GitCompare, MessagesSquare, Network, RefreshCw, ScrollText, Workflow, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { Architecture } from "@/components/workspace/architecture";
import { Compare } from "@/components/workspace/compare";
import { FileTab } from "@/components/workspace/file-tab";
import { FlowTab } from "@/components/workspace/flow-tab";
import { type Tab, useNav } from "@/components/workspace/nav";
import { Overview } from "@/components/workspace/overview";
import { ReportPanel } from "@/components/workspace/report";
import { SymbolTab } from "@/components/workspace/symbol-tab";
import { Button, ErrorState, IconButton, cn } from "@/components/ui";

const ICONS: Record<Tab["view"], typeof Boxes> = {
  overview: Boxes,
  code: FileCode,
  symbol: Braces,
  architecture: Network,
  flow: Workflow,
  report: ScrollText,
  compare: GitCompare,
};

export function Canvas() {
  const nav = useNav();
  const s = nav.snapshot;
  const active = nav.tabs.find((t) => t.id === nav.activeTabId);
  return (
    <>
      <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-panel">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto" role="tablist" aria-label="Open investigation contexts">
          {nav.tabs.map((t) => {
            const Icon = ICONS[t.view] ?? Boxes;
            const selected = t.id === nav.activeTabId;
            const sub = t.view === "code" ? t.params.file : t.view === "symbol" ? t.params.key : t.view === "flow" ? t.params.entry : undefined;
            return (
              <div
                key={t.id}
                role="presentation"
                className={cn(
                  "group relative flex max-w-[220px] shrink-0 items-center border-r border-line text-[12.5px]",
                  selected ? "bg-bg text-fg after:absolute after:inset-x-0 after:top-0 after:h-[2px] after:bg-accent" : "text-fg-3 hover:bg-panel-2 hover:text-fg",
                )}
              >
                <button
                  role="tab"
                  ref={selected ? (el) => el?.scrollIntoView({ block: "nearest", inline: "nearest" }) : undefined}
                  aria-selected={selected}
                  aria-label={t.view === "flow" ? `Flow ${t.title}` : t.title}
                  title={sub ?? t.title}
                  onClick={() => nav.activate(t.id)}
                  onAuxClick={(e) => e.button === 1 && nav.close(t.id)}
                  onKeyDown={(e) => e.key === "Delete" && t.id !== "overview" && nav.close(t.id)}
                  className="flex h-full min-w-0 items-center gap-1.5 pr-1 pl-3"
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{t.view === "flow" ? `Flow · ${t.title}` : t.view === "symbol" ? `${t.title}` : t.title}</span>
                </button>
                {t.id !== "overview" ? (
                  // Pointer affordance only; keyboard users close the focused tab with Delete (or Alt+W).
                  <span
                    aria-hidden
                    data-close-tab={t.title}
                    onClick={() => nav.close(t.id)}
                    title="Close (Delete or Alt+W)"
                    className={cn("mr-1.5 cursor-pointer rounded p-0.5 text-fg-3 hover:bg-panel-3 hover:text-fg", !selected && "opacity-0 group-hover:opacity-100")}
                  >
                    <X className="h-3 w-3" />
                  </span>
                ) : (
                  <span className="w-2" />
                )}
              </div>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-1 border-l border-line px-2">
          <IconButton label="Architecture graph (Alt+3)" onClick={() => nav.openGraph()} active={nav.view === "architecture"}>
            <Network className="h-4 w-4" />
          </IconButton>
          <IconButton label="Compare snapshots (Alt+6)" onClick={() => nav.setView("compare")} active={nav.view === "compare"}>
            <GitCompare className="h-4 w-4" />
          </IconButton>
          <IconButton label="Technical report (Alt+5)" onClick={() => nav.setView("report")} active={nav.view === "report"}>
            <ScrollText className="h-4 w-4" />
          </IconButton>
          <RefreshButton repositoryId={s.repository.id} />
          <Button
            size="sm"
            variant={nav.assistantOpen ? "secondary" : "primary"}
            onClick={() => nav.setAssistantOpen(!nav.assistantOpen)}
            aria-pressed={nav.assistantOpen}
            title="Toggle the investigation assistant (Ctrl+I)"
            className="ml-1"
          >
            <MessagesSquare className="h-3.5 w-3.5" aria-hidden /> Assistant
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1" role="tabpanel" aria-label={active?.title ?? "Overview"}>
        {nav.view === "overview" && <Overview snapshot={s} />}
        {nav.view === "code" && <FileTab />}
        {nav.view === "symbol" && <SymbolTab />}
        {nav.view === "architecture" && <Architecture snapshot={s} />}
        {nav.view === "flow" && <FlowTab />}
        {nav.view === "report" && <ReportPanel snapshot={s} />}
        {nav.view === "compare" && <Compare snapshot={s} />}
      </div>
    </>
  );
}

function RefreshButton({ repositoryId }: { repositoryId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <span className="relative">
      <IconButton
        label="Refresh analysis: check GitHub for a newer commit; a new commit is analysed into a new snapshot (this one is kept)"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          api.refreshRepository(repositoryId).then(
            (r) => router.push(`/jobs/${r.job.id}`),
            (e) => {
              setError(e);
              setBusy(false);
            },
          );
        }}
      >
        <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} />
      </IconButton>
      {error ? <div className="absolute top-8 right-0 z-20 w-72"><ErrorState error={error} compact /></div> : null}
    </span>
  );
}
