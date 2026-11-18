"use client";

import { FileCode } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";
import { api, type EvidenceDetail } from "@/lib/api";
import { cn } from "@/components/ui";

export type View = "overview" | "code" | "architecture" | "investigate" | "report" | "compare";

export interface WorkspaceNav {
  snapshotId: number;
  view: View;
  setView: (v: View) => void;
  openSource: (loc: { path: string; start?: number | null; end?: number | null; sym?: string }) => void;
  openEvidence: (id: string) => Promise<void>;
  focusGraph: (key: string, tab?: "usage" | "impact" | "flow") => void;
  ask: (question: string) => void;
  param: (name: string) => string | null;
  setParams: (patch: Record<string, string | null>) => void;
}

export const NavContext = createContext<WorkspaceNav | null>(null);

export function useNav(): WorkspaceNav {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error("useNav outside workspace");
  return ctx;
}

// Evidence locations are immutable per snapshot, so a module-level cache is safe.
const cache = new Map<string, Promise<EvidenceDetail>>();
export function getEvidence(id: string): Promise<EvidenceDetail> {
  let p = cache.get(id);
  if (!p) {
    p = api.evidence(id);
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

/** A clickable source citation. Resolves the evidence ID to `path:lines` and opens the exact range. */
export function EvidenceChip({ id, className }: { id: string; className?: string }) {
  const nav = useNav();
  const [ev, setEv] = useState<EvidenceDetail | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    getEvidence(id).then(
      (e) => alive && setEv(e),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [id]);
  const label = ev ? `${ev.path.split("/").slice(-2).join("/")}:${ev.start_line}${ev.end_line !== ev.start_line ? `-${ev.end_line}` : ""}` : failed ? "unavailable" : id.slice(0, 11);
  return (
    <button
      type="button"
      disabled={failed}
      onClick={() => ev && nav.openSource({ path: ev.path, start: ev.start_line, end: ev.end_line })}
      title={ev ? `${ev.path}:${ev.start_line}-${ev.end_line} · ${ev.category} · ${ev.source_kind} · ${ev.verified_now ? "verified" : "NOT verified"} · ${id}` : id}
      data-evidence-id={id}
      className={cn(
        "inline-flex h-[20px] max-w-[260px] items-center gap-1 rounded border border-line bg-panel-2 px-1.5 font-mono text-[11px] text-fg-2 transition-colors hover:border-accent hover:text-accent disabled:opacity-50",
        ev && !ev.verified_now && "border-bad/50 text-bad",
        className,
      )}
    >
      <FileCode className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  );
}

export function EvidenceList({ ids, max = 6 }: { ids: (string | null | undefined)[]; max?: number }) {
  const clean = ids.filter((i): i is string => !!i);
  if (!clean.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {clean.slice(0, max).map((i) => (
        <EvidenceChip key={i} id={i} />
      ))}
      {clean.length > max && <span className="text-[11px] text-fg-3">+{clean.length - max}</span>}
    </span>
  );
}
