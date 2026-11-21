"use client";

import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import Link from "next/link";
import { ApiError, api, type Snapshot } from "@/lib/api";
import { useAsync, useHotkey, usePref, writePref } from "@/lib/hooks";
import { Assistant } from "@/components/workspace/assistant";
import { Canvas } from "@/components/workspace/canvas";
import { Explorer } from "@/components/workspace/explorer";
import { NavContext, TAB_PARAMS, type Selection, type Tab, type View, type WorkspaceNav, getEvidence, keyPath, symbolLabel, tabFromParams } from "@/components/workspace/nav";
import { Button, ErrorState, Spinner } from "@/components/ui";

const MAX_TABS = 12;
const OVERVIEW: Tab = { id: "overview", view: "overview", title: "Overview", params: { view: "overview" } };

function defaultSelection(active: Tab): Selection | null {
  const key = active.view === "symbol" ? active.params.key : undefined;
  if (key) return { kind: key.startsWith("file:") ? "file" : key.startsWith("route:") ? "route" : "symbol", key, label: symbolLabel(key), path: keyPath(key) };
  const file = active.view === "code" ? active.params.file : undefined;
  if (file) return { kind: "file", key: `file:${file}`, label: file.split("/").pop() ?? file, path: file };
  return null;
}

function readTabs(snapshotId: number): Tab[] {
  try {
    const raw = window.localStorage.getItem(`ip.tabs.${snapshotId}`);
    const parsed = raw ? (JSON.parse(raw) as Tab[]) : [];
    return Array.isArray(parsed) ? parsed.filter((t) => t && typeof t.id === "string" && t.params) : [];
  } catch {
    return [];
  }
}

export function WorkspaceView() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const snap = useAsync(() => api.snapshot(id), [id]);

  if (snap.error instanceof ApiError && snap.error.status === 404) return <SnapshotNotFound id={id} />;
  if (snap.error) return <div className="p-6"><ErrorState error={snap.error} onRetry={snap.reload} /></div>;
  if (!snap.data) return <div className="p-6"><Spinner label="Loading workspace" /></div>;
  // Keyed by snapshot: tabs, selection and assistant state never leak between snapshots.
  return <Workspace key={snap.data.id} snapshot={snap.data} />;
}

function Workspace({ snapshot }: { snapshot: Snapshot }) {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const sid = snapshot.id;
  const [stored, setStored] = useState<Tab[]>(() => (typeof window === "undefined" ? [] : readTabs(sid)));
  // A selection belongs to the tab it was made in; other tabs fall back to what they show.
  const [picked, setPicked] = useState<{ tabId: string; sel: Selection | null } | null>(null);
  const askerRef = useRef<((question: string, send: boolean) => void) | null>(null);
  const pendingAsk = useRef<{ question: string; send: boolean } | null>(null);
  // On narrow windows the assistant starts collapsed (until the user opens it; the choice is remembered).
  const [assistantPref, setAssistantPref] = usePref("ip.assistant", typeof window !== "undefined" && window.innerWidth < 1200 ? "closed" : "open");
  const [explorerPref, setExplorerPref] = usePref("ip.explorer", "open");
  const assistantOpen = assistantPref === "open";
  const explorerRef = usePanelRef();
  const assistantRef = usePanelRef();
  const layout = useDefaultLayout({ id: "ip.workspace.layout.v2" });

  const active = useMemo(() => tabFromParams(new URLSearchParams(search.toString())), [search]);

  useEffect(() => {
    writePref("ip.lastSnapshot", String(sid));
  }, [sid]);

  // Old `?view=investigate` links: show the assistant beside the overview.
  useEffect(() => {
    if (search.get("view") === "investigate") {
      setAssistantPref("open");
      const sp = new URLSearchParams(search.toString());
      sp.set("view", "overview");
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
    }
  }, [search, router, pathname, setAssistantPref]);

  // Open tabs = remembered tabs + the context the URL shows (with its latest parameters). Updated while
  // rendering (not in an effect) so that every navigation — including browser back/forward — is kept.
  const [closing, setClosing] = useState<string | null>(null);
  if (closing && closing !== active.id) setClosing(null);
  const tabs = useMemo(() => {
    const i = stored.findIndex((t) => t.id === active.id);
    const base = stored.filter((t) => t.id !== "overview");
    const next = i === -1 ? (closing === active.id ? base : [...base, active].slice(-MAX_TABS)) : stored.map((t, j) => (j === i ? active : t)).filter((t) => t.id !== "overview");
    return [OVERVIEW, ...next];
  }, [stored, active, closing]);
  if (JSON.stringify(tabs) !== JSON.stringify(stored)) setStored(tabs);

  useEffect(() => {
    try {
      window.localStorage.setItem(`ip.tabs.${sid}`, JSON.stringify(tabs));
    } catch {
      /* storage unavailable */
    }
  }, [tabs, sid]);

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

  /** Switch the active context: replaces tab parameters, keeps the rest (e.g. the open conversation). */
  const go = useCallback(
    (tabParams: Record<string, string>, push = true) => {
      const sp = new URLSearchParams(search.toString());
      for (const k of TAB_PARAMS) sp.delete(k);
      for (const [k, v] of Object.entries(tabParams)) sp.set(k, v);
      const url = `${pathname}?${sp.toString()}`;
      if (push) router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [pathname, router, search],
  );

  const setAssistantOpen = useCallback(
    (open: boolean) => {
      setAssistantPref(open ? "open" : "closed");
      const p = assistantRef.current;
      if (p) {
        if (open) p.expand();
        else p.collapse();
      }
    },
    [assistantRef, setAssistantPref],
  );

  const nav = useMemo<WorkspaceNav>(() => {
    const byId = (tid: string) => tabs.find((t) => t.id === tid);
    return {
      snapshotId: sid,
      snapshot,
      view: active.view,
      tabs,
      activeTabId: active.id,
      activate: (tid) => {
        const t = byId(tid);
        if (t) go(t.params, false);
      },
      close: (tid) => {
        if (tid === "overview") return;
        const idx = tabs.findIndex((t) => t.id === tid);
        const remaining = tabs.filter((t) => t.id !== tid);
        setStored(remaining);
        if (tid === active.id) {
          setClosing(tid);
          const next = remaining[Math.min(idx, remaining.length - 1)] ?? remaining[0];
          go(next ? next.params : { view: "overview" }, false);
        }
      },
      setView: (v: View) => {
        if (v === "investigate") return setAssistantOpen(true);
        if (v === "code") {
          const lastFile = [...tabs].reverse().find((t) => t.view === "code");
          return go(lastFile ? lastFile.params : { view: "code" });
        }
        const existing = tabs.find((t) => t.view === v);
        go(existing ? existing.params : { view: v });
      },
      openSource: ({ path, start, end, sym }) => {
        const p: Record<string, string> = { view: "code", file: path };
        if (start) p.l = `${start}-${end ?? start}`;
        if (sym) p.sym = sym;
        go(p);
      },
      openEvidence: async (eid) => {
        const ev = await getEvidence(eid);
        go({ view: "code", file: ev.path, l: `${ev.start_line}-${ev.end_line}` });
      },
      openSymbol: (key, section) => go({ view: "symbol", key, ...(section ? { section } : {}) }),
      focusGraph: (key, tab) => {
        if (tab === "flow") return go({ view: "flow", entry: key });
        if (key.startsWith("sym:") || key.startsWith("file:")) return go({ view: "symbol", key, section: tab === "impact" ? "impact" : "usage" });
        go({ view: "architecture", gview: "focus", focus: key, node: key });
      },
      openGraph: (p) => {
        const params: Record<string, string> = { view: "architecture" };
        if (p?.gview) params.gview = p.gview;
        if (p?.focus) params.focus = p.focus;
        if (p?.node) params.node = p.node;
        if (p?.prefix) params.prefix = p.prefix;
        if (!p) {
          const existing = tabs.find((t) => t.view === "architecture");
          if (existing) return go(existing.params);
        }
        go(params);
      },
      openFlow: (startKey) => go({ view: "flow", entry: startKey }),
      ask: (question, opts) => {
        setAssistantOpen(true);
        if (askerRef.current) askerRef.current(question, !!opts?.send);
        else pendingAsk.current = { question, send: !!opts?.send };
      },
      setAsker: (fn) => {
        askerRef.current = fn;
        const queued = pendingAsk.current;
        if (fn && queued) {
          pendingAsk.current = null;
          fn(queued.question, queued.send);
        }
      },
      selection: picked && picked.tabId === active.id ? picked.sel : defaultSelection(active),
      setSelection: (s) => setPicked((prev) => (prev?.tabId === active.id && prev.sel?.key === s?.key && prev.sel?.start === s?.start ? prev : { tabId: active.id, sel: s })),
      assistantOpen,
      setAssistantOpen,
      focusMode: explorerPref === "closed" && !assistantOpen,
      toggleFocus: () => {
        const p = explorerRef.current;
        const entering = !(explorerPref === "closed" && !assistantOpen);
        if (entering) {
          try {
            sessionStorage.setItem("ip.focus.restore", JSON.stringify({ explorer: explorerPref, assistant: assistantOpen }));
          } catch {
            /* storage unavailable */
          }
          p?.collapse();
          setExplorerPref("closed");
          setAssistantOpen(false);
        } else {
          let restore = { explorer: "open", assistant: true };
          try {
            restore = { ...restore, ...JSON.parse(sessionStorage.getItem("ip.focus.restore") ?? "{}") };
          } catch {
            /* default restore */
          }
          if (restore.explorer !== "closed") {
            p?.expand();
            setExplorerPref("open");
          }
          setAssistantOpen(restore.assistant !== false);
        }
      },
      param: (name) => search.get(name),
      setParams,
    };
  }, [sid, snapshot, active, tabs, go, setAssistantOpen, picked, assistantOpen, search, setParams, explorerPref, explorerRef, setExplorerPref]);

  useHotkey("mod+b", () => {
    const p = explorerRef.current;
    if (!p) return;
    if (p.isCollapsed()) {
      p.expand();
      setExplorerPref("open");
    } else {
      p.collapse();
      setExplorerPref("closed");
    }
  }, { allowInInputs: true });
  useHotkey("mod+i", () => setAssistantOpen(!assistantOpen), { allowInInputs: true });
  useHotkey("mod+.", () => nav.toggleFocus(), { allowInInputs: true });
  useHotkey("alt+1", () => nav.setView("overview"));
  useHotkey("alt+2", () => nav.setView("code"));
  useHotkey("alt+3", () => nav.setView("architecture"));
  useHotkey("alt+4", () => setAssistantOpen(true));
  useHotkey("alt+5", () => nav.setView("report"));
  useHotkey("alt+6", () => nav.setView("compare"));
  useHotkey("alt+w", () => nav.close(active.id));

  return (
    <NavContext.Provider value={nav}>
      <Group orientation="horizontal" id="ip.workspace.layout.v2" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged} className="h-full">
        <Panel
          id="explorer"
          panelRef={explorerRef}
          defaultSize="20"
          minSize="14"
          maxSize="34"
          collapsible
          collapsedSize="0"
          onResize={(size) => setExplorerPref(size.asPercentage === 0 ? "closed" : "open")}
          className="flex min-h-0 flex-col border-r border-line bg-panel"
          data-collapsed={explorerPref === "closed" || undefined}
        >
          <Explorer />
        </Panel>
        <Separator aria-label="Resize repository explorer" />
        <Panel id="canvas" defaultSize="52" minSize="30" className="flex min-h-0 min-w-0 flex-col">
          <Canvas />
        </Panel>
        <Separator aria-label="Resize investigation assistant" />
        <Panel
          id="assistant"
          panelRef={assistantRef}
          defaultSize={assistantOpen ? "28" : "0"}
          minSize="20"
          maxSize="50"
          collapsible
          collapsedSize="0"
          onResize={(size) => {
            const open = size.asPercentage > 0;
            if (open !== assistantOpen) setAssistantPref(open ? "open" : "closed");
          }}
          className="flex min-h-0 flex-col border-l border-line bg-panel"
        >
          {assistantOpen && <Assistant />}
        </Panel>
      </Group>
    </NavContext.Provider>
  );
}

function SnapshotNotFound({ id }: { id: number }) {
  return (
    <div className="atlas-grid flex h-full items-center justify-center p-6">
      <section role="alert" aria-labelledby="nf-title" className="atlas-in max-w-[480px] text-center">
        <div className="atlas-label">snapshot {id} · not on this map</div>
        <h1 id="nf-title" className="atlas-display mt-2 text-[40px] text-fg">Snapshot not found</h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-fg-2">
          This analysis does not exist in this installation. The link may come from another machine, or the database was reset.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Link href="/repositories"><Button variant="primary">Browse repositories</Button></Link>
          <Link href="/"><Button>Analyse a repository</Button></Link>
        </div>
      </section>
    </div>
  );
}
