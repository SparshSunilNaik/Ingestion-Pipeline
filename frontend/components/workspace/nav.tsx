"use client";

import { FileCode } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";
import { api, type EvidenceDetail, type Snapshot } from "@/lib/api";
import { cn } from "@/components/ui";

/**
 * Workspace navigation model.
 *
 * The URL is the source of truth for the *active* investigation context (`?view=…` plus that view's
 * parameters), so every context is a shareable deep link and older links (`?view=code&file=…`) keep
 * working. Open tabs are remembered per snapshot in localStorage. The assistant panel is independent of
 * tabs: it stays open while the user moves between code, graph and flows.
 */
export type View = "overview" | "code" | "symbol" | "architecture" | "flow" | "report" | "compare" | "investigate";

export interface Tab {
  id: string;
  view: Exclude<View, "investigate">;
  title: string;
  params: Record<string, string>;
}

export interface Selection {
  kind: "file" | "symbol" | "route" | "module" | "package";
  key: string;
  label: string;
  path?: string | null;
  start?: number | null;
  end?: number | null;
  symbolKind?: string;
}

export interface WorkspaceNav {
  snapshotId: number;
  snapshot: Snapshot;
  view: View;
  tabs: Tab[];
  activeTabId: string;
  activate: (id: string) => void;
  close: (id: string) => void;
  setView: (v: View) => void;
  openSource: (loc: { path: string; start?: number | null; end?: number | null; sym?: string }) => void;
  openEvidence: (id: string) => Promise<void>;
  openSymbol: (key: string, section?: "usage" | "impact" | "dependencies") => void;
  focusGraph: (key: string, tab?: "usage" | "impact" | "flow") => void;
  openGraph: (p?: { gview?: string; focus?: string; node?: string; prefix?: string }) => void;
  openFlow: (startKey: string) => void;
  /** Open the assistant with a question; `send` submits it immediately. */
  ask: (question: string, opts?: { send?: boolean }) => void;
  /** The assistant registers the handler that receives `ask` requests. */
  setAsker: (fn: ((question: string, send: boolean) => void) | null) => void;
  selection: Selection | null;
  setSelection: (s: Selection | null) => void;
  assistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
  param: (name: string) => string | null;
  setParams: (patch: Record<string, string | null>) => void;
}

export const NavContext = createContext<WorkspaceNav | null>(null);

export function useNav(): WorkspaceNav {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error("useNav outside workspace");
  return ctx;
}

/** URL parameters that belong to a tab (everything else, e.g. the conversation `c`, survives tab switches). */
export const TAB_PARAMS = ["view", "file", "l", "sym", "key", "section", "gview", "focus", "node", "tab", "entry", "base", "prefix", "impact"] as const;

export function symbolLabel(key: string): string {
  if (key.startsWith("sym:")) return key.split("#").pop() ?? key;
  if (key.startsWith("file:")) return key.slice(5).split("/").pop() ?? key;
  if (key.startsWith("route:")) return key.slice(6).split("@")[0];
  return key.replace(/^[a-z]+:/, "");
}

export function keyPath(key: string): string | null {
  if (key.startsWith("sym:")) return key.slice(4).split("#")[0];
  if (key.startsWith("file:")) return key.slice(5);
  return null;
}

/** Derive the tab that the current URL describes. */
export function tabFromParams(sp: URLSearchParams): Tab {
  const v = sp.get("view");
  const pick = (...names: string[]) => Object.fromEntries(names.flatMap((n) => (sp.get(n) ? [[n, sp.get(n) as string]] : [])));
  const file = sp.get("file");
  if ((v === "code" || (!v && file)) && file) {
    return { id: `file:${file}`, view: "code", title: file.split("/").pop() ?? file, params: { view: "code", ...pick("file", "l", "sym") } };
  }
  if (v === "symbol" && sp.get("key")) {
    const key = sp.get("key") as string;
    return { id: `symbol:${key}`, view: "symbol", title: symbolLabel(key), params: { view: "symbol", ...pick("key", "section") } };
  }
  // Older links put flows under the architecture view.
  if ((v === "flow" || (v === "architecture" && sp.get("gview") === "flows")) && sp.get("entry")) {
    const entry = sp.get("entry") as string;
    return { id: `flow:${entry}`, view: "flow", title: symbolLabel(entry), params: { view: "flow", entry } };
  }
  if (v === "architecture") {
    return { id: "graph", view: "architecture", title: "Architecture", params: { view: "architecture", ...pick("gview", "focus", "node", "tab", "prefix", "impact") } };
  }
  if (v === "report") return { id: "report", view: "report", title: "Report", params: { view: "report" } };
  if (v === "compare") return { id: "compare", view: "compare", title: "Compare", params: { view: "compare", ...pick("base") } };
  return { id: "overview", view: "overview", title: "Overview", params: { view: "overview" } };
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
  const where = ev ? `${ev.path} lines ${ev.start_line}–${ev.end_line}` : "evidence";
  return (
    <button
      type="button"
      disabled={failed}
      onClick={() => ev && nav.openSource({ path: ev.path, start: ev.start_line, end: ev.end_line })}
      title={ev ? `${ev.path}:${ev.start_line}-${ev.end_line} · ${ev.category} · ${ev.source_kind} · ${ev.verified_now ? "verified" : "NOT verified"} · ${id}` : id}
      aria-label={ev ? `${label}, open ${where}` : `${label}, ${where}`}
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
