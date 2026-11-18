"use client";

import { Braces, ChevronDown, ChevronRight, FileCode, Folder, FolderOpen, MessagesSquare, Play, Plus, Route, Search, Terminal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type RetrievalResult, type TreeFile } from "@/lib/api";
import { useAsync, useHotkey, usePref } from "@/lib/hooks";
import { Badge, ErrorState, SkeletonRows, cn, formatBytes, formatTime } from "@/components/ui";
import { useNav } from "@/components/workspace/nav";

type Section = "files" | "symbols" | "entries" | "chats";
const SECTIONS: { id: Section; label: string; icon: typeof FileCode }[] = [
  { id: "files", label: "Files", icon: FileCode },
  { id: "symbols", label: "Symbols", icon: Braces },
  { id: "entries", label: "Entry points", icon: Route },
  { id: "chats", label: "Investigations", icon: MessagesSquare },
];

export function Explorer() {
  const nav = useNav();
  const s = nav.snapshot;
  const [section, setSection] = usePref("ip.explorer.section", "files");
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useHotkey("/", () => inputRef.current?.focus());
  const sec = (SECTIONS.some((x) => x.id === section) ? section : "files") as Section;

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="Repository explorer">
      <div className="shrink-0 border-b border-line px-3 pt-2.5 pb-2">
        <div className="truncate text-[13px] font-semibold" title={s.repository.canonical_url}>
          {s.repository.owner}/<span className="text-fg">{s.repository.name}</span>
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-fg-3" title={`commit ${s.commit_sha} · analyzer ${s.analyzer_version}`}>
          {s.default_branch ?? "HEAD"} @ {s.commit_sha.slice(0, 10)} · {s.coverage.analyzed_files} files analysed
        </div>
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Search code, symbols, files"
            aria-label="Search this repository"
            className="h-8 w-full rounded-md border border-line bg-panel-2 pr-7 pl-7 text-[12.5px] outline-none placeholder:text-fg-3 focus:border-accent"
          />
          {query ? (
            <button className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-fg-3 hover:text-fg" onClick={() => setQuery("")} aria-label="Clear search">
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 font-mono text-[10.5px] text-fg-3">/</kbd>
          )}
        </div>
      </div>
      {query.trim().length >= 2 ? (
        <SearchResults query={query.trim()} onDone={() => setQuery("")} />
      ) : (
        <>
          <div className="flex shrink-0 gap-0.5 border-b border-line px-2 py-1" role="tablist" aria-label="Explorer sections">
            {SECTIONS.map((x) => (
              <button
                key={x.id}
                role="tab"
                aria-selected={sec === x.id}
                aria-label={x.label}
                title={x.label}
                onClick={() => setSection(x.id)}
                className={cn("flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium", sec === x.id ? "flex-1 bg-panel-3 text-fg" : "text-fg-3 hover:bg-panel-2 hover:text-fg")}
              >
                <x.icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {sec === x.id && <span className="truncate">{x.label}</span>}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto" role="tabpanel">
            {sec === "files" && <FilesSection />}
            {sec === "symbols" && <SymbolsSection />}
            {sec === "entries" && <EntriesSection />}
            {sec === "chats" && <ChatsSection />}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- search
function SearchResults({ query, onDone }: { query: string; onDone: () => void }) {
  const nav = useNav();
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);
  const res = useAsync(() => api.retrieve(nav.snapshotId, debounced, 25), [nav.snapshotId, debounced]);
  const open = (r: RetrievalResult) => {
    nav.openSource({ path: r.path, start: r.start_line, end: r.end_line, sym: r.kind === "symbol" ? r.key : undefined });
  };
  return (
    <div className="min-h-0 flex-1 overflow-auto" aria-live="polite">
      {res.error ? <div className="p-3"><ErrorState error={res.error} compact onRetry={res.reload} /></div> : null}
      {!res.data && !res.error && <div className="p-3"><SkeletonRows rows={6} /></div>}
      {res.data && res.data.results.length === 0 && <p className="p-3 text-[12.5px] text-fg-3">Nothing matches “{debounced}”. Try a function name, a file name or words from the code.</p>}
      <ul className="py-1">
        {res.data?.results.map((r) => (
          <li key={`${r.key}:${r.start_line}`}>
            <button
              onClick={() => open(r)}
              onKeyDown={(e) => e.key === "Escape" && onDone()}
              className="block w-full px-3 py-1.5 text-left hover:bg-panel-3 focus-visible:bg-panel-3"
              title={`${r.path}:${r.start_line} · ${r.signals.join(", ")}`}
            >
              <div className="flex items-center gap-1.5">
                {r.kind === "symbol" ? <Braces className="h-3.5 w-3.5 shrink-0 text-[var(--k-function)]" aria-hidden /> : <FileCode className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden />}
                <span className="min-w-0 truncate font-mono text-[12px]">{r.label}</span>
                {r.symbol_kind && <span className="ml-auto shrink-0 text-[10.5px] text-fg-3">{r.symbol_kind}</span>}
              </div>
              <div className="truncate pl-5 text-[11px] text-fg-3">{r.path}:{r.start_line}</div>
              {r.snippet && r.kind === "text" && <div className="truncate pl-5 font-mono text-[11px] text-fg-2">{r.snippet}</div>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- files
interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: TreeFile[];
}

function buildTree(files: TreeFile[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.p.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = cur.dirs.get(parts[i]);
      if (!next) {
        next = { name: parts[i], path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] };
        cur.dirs.set(parts[i], next);
      }
      cur = next;
    }
    cur.files.push(f);
  }
  return root;
}

function FilesSection() {
  const nav = useNav();
  const tree = useAsync(() => api.tree(nav.snapshotId), [nav.snapshotId]);
  const selected = nav.view === "code" ? nav.param("file") : null;
  if (tree.error) return <div className="p-3"><ErrorState error={tree.error} onRetry={tree.reload} /></div>;
  if (!tree.data) return <div className="p-3"><SkeletonRows rows={12} /></div>;
  return <FileTree files={tree.data.files} selected={selected} onOpen={(p) => nav.openSource({ path: p })} />;
}

export function FileTree({ files, selected, onOpen }: { files: TreeFile[]; selected: string | null; onOpen: (path: string) => void }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set([""]));
  const root = useMemo(() => buildTree(files), [files]);
  const expanded = useMemo(() => {
    const set = new Set(open);
    if (selected) {
      const parts = selected.split("/");
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join("/"));
    }
    // A single top-level directory is opened automatically.
    if (root.dirs.size === 1 && root.files.length === 0) set.add([...root.dirs.values()][0].path);
    return set;
  }, [open, selected, root]);
  const toggle = (p: string) =>
    setOpen((prev) => {
      const n = new Set(prev);
      if (expanded.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const rows: React.ReactNode[] = [];
  const walk = (d: DirNode, depth: number) => {
    for (const sub of [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const isOpen = expanded.has(sub.path);
      rows.push(
        <li key={`d:${sub.path}`} role="treeitem" aria-expanded={isOpen} aria-selected={false}>
          <button onClick={() => toggle(sub.path)} className="flex h-[24px] w-full items-center gap-1 pr-2 text-left text-[12.5px] text-fg-2 hover:bg-panel-3" style={{ paddingLeft: 6 + depth * 12 }}>
            {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" aria-hidden /> : <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />}
            {isOpen ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden /> : <Folder className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden />}
            <span className="truncate">{sub.name}</span>
          </button>
        </li>,
      );
      if (isOpen) walk(sub, depth + 1);
    }
    for (const f of [...d.files].sort((a, b) => a.p.localeCompare(b.p))) {
      rows.push(
        <li key={f.p} role="treeitem" aria-selected={selected === f.p}>
          <button
            onClick={() => f.a && onOpen(f.p)}
            aria-disabled={!f.a}
            title={f.a ? `${f.p} · ${f.l ?? f.c} · ${formatBytes(f.s)}` : `${f.p} — not analysed (${(f.x ?? f.c).replaceAll("_", " ")})`}
            className={cn(
              "flex h-[24px] w-full items-center gap-1.5 pr-2 text-left text-[12.5px]",
              selected === f.p ? "bg-accent-soft text-accent" : f.a ? "text-fg-2 hover:bg-panel-3 hover:text-fg" : "cursor-default text-fg-3",
            )}
            style={{ paddingLeft: 20 + depth * 12 }}
          >
            <FileCode className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
            <span className="truncate">{f.p.split("/").pop()}</span>
            {!f.a && <span className="ml-auto shrink-0 text-[10px]">{(f.x ?? "skipped").replaceAll("_", " ")}</span>}
          </button>
        </li>,
      );
    }
  };
  walk(root, 0);
  return (
    <ul className="py-1" role="tree" aria-label="Repository files">
      {rows}
    </ul>
  );
}

// ---------------------------------------------------------------- symbols
function SymbolsSection() {
  const nav = useNav();
  const s = nav.snapshot;
  const [kind, setKind] = useState("");
  const syms = useAsync(() => (kind ? api.symbols(nav.snapshotId, { kind, limit: 200 }) : Promise.resolve(null)), [nav.snapshotId, kind]);
  const top = s.analysis_summary.most_referenced_symbols ?? [];
  const kinds = Object.entries(s.analysis_summary.stats ?? {})
    .filter(([k, v]) => k.startsWith("symbols_") && v > 0)
    .map(([k, v]) => [k.slice(8), v] as const)
    .sort((a, b) => b[1] - a[1]);
  return (
    <div className="py-2">
      <div className="flex flex-wrap gap-1 px-3 pb-2">
        <KindChip active={!kind} onClick={() => setKind("")}>Most used</KindChip>
        {kinds.map(([k, n]) => (
          <KindChip key={k} active={kind === k} onClick={() => setKind(k)}>
            {k} <span className="text-fg-3">{n}</span>
          </KindChip>
        ))}
      </div>
      {!kind && (
        <>
          {top.length === 0 && <p className="px-3 text-[12px] text-fg-3">No cross-file references were resolved in this snapshot.</p>}
          <ul>
            {top.map((m) => (
              <li key={m.key}>
                <SymbolRowButton label={m.label} kind={m.kind} sub={`${m.references} refs · ${m.path}`} onClick={() => nav.openSymbol(m.key)} />
              </li>
            ))}
          </ul>
        </>
      )}
      {kind && !syms.data && <div className="px-3"><SkeletonRows rows={6} /></div>}
      {kind && syms.data && (
        <ul>
          {syms.data.map((x) => (
            <li key={x.id}>
              <SymbolRowButton label={x.qualified_name} kind={x.kind} sub={`${x.path}:${x.start_line}`} onClick={() => nav.openSource({ path: x.path, start: x.start_line, end: x.end_line, sym: `sym:${x.path}#${x.qualified_name}` })} />
            </li>
          ))}
          {syms.data.length === 200 && <li className="px-3 py-1 text-[11px] text-fg-3">Showing the first 200 — use search to narrow down.</li>}
        </ul>
      )}
    </div>
  );
}

function KindChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={active} className={cn("h-6 rounded-full border px-2 text-[11.5px]", active ? "border-accent bg-accent-soft text-accent" : "border-line text-fg-2 hover:border-line-strong")}>
      {children}
    </button>
  );
}

function SymbolRowButton({ label, kind, sub, onClick }: { label: string; kind: string; sub: string; onClick: () => void }) {
  const color = kind === "method" ? "var(--k-method)" : kind === "class" || kind === "interface" || kind === "enum" ? "var(--k-class)" : "var(--k-function)";
  return (
    <button onClick={onClick} className="block w-full px-3 py-1 text-left hover:bg-panel-3" title={`${kind} ${label}`}>
      <div className="flex items-center gap-1.5">
        <Braces className="h-3 w-3 shrink-0" style={{ color }} aria-hidden />
        <span className="min-w-0 truncate font-mono text-[12px]">{label}</span>
      </div>
      <div className="truncate pl-[18px] text-[11px] text-fg-3">{sub}</div>
    </button>
  );
}

// ---------------------------------------------------------------- entry points
function EntriesSection() {
  const nav = useNav();
  const eps = useAsync(() => api.entryPoints(nav.snapshotId), [nav.snapshotId]);
  const activeEntry = nav.view === "flow" ? nav.param("entry") : null;
  if (eps.error) return <div className="p-3"><ErrorState error={eps.error} onRetry={eps.reload} /></div>;
  if (!eps.data) return <div className="p-3"><SkeletonRows rows={6} /></div>;
  const routes = eps.data.filter((e) => e.kind === "route");
  const others = eps.data.filter((e) => e.kind !== "route");
  if (!eps.data.length) {
    return <p className="p-3 text-[12.5px] text-fg-3">No routes, main functions or CLI entry points were detected. Use Search or the Symbols list to start a trace from any function.</p>;
  }
  const row = (e: (typeof eps.data)[number]) => (
    <li key={`${e.kind}:${e.label}:${e.start_key}`} className="group flex items-center">
      <button
        disabled={!e.traceable || !e.start_key}
        onClick={() => e.start_key && nav.openFlow(e.start_key)}
        title={e.traceable ? `Trace possible execution from ${e.label}` : "Not traceable: the handler could not be resolved"}
        className={cn("flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-[12.5px] disabled:opacity-50", activeEntry && activeEntry === e.start_key ? "bg-accent-soft text-accent" : "hover:bg-panel-3")}
      >
        {e.kind === "route" ? <Badge tone="accent">{e.framework ?? "route"}</Badge> : <Terminal className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden />}
        <span className="min-w-0 truncate font-mono text-[12px]">{e.label}</span>
        {e.traceable && <Play className="ml-auto h-3 w-3 shrink-0 text-fg-3 opacity-0 group-hover:opacity-100" aria-hidden />}
      </button>
    </li>
  );
  return (
    <div className="py-1">
      {routes.length > 0 && <h3 className="px-3 pt-1 pb-0.5 text-[10.5px] font-semibold tracking-wider text-fg-3 uppercase">API routes · {routes.length}</h3>}
      <ul>{routes.map(row)}</ul>
      {others.length > 0 && <h3 className="px-3 pt-2 pb-0.5 text-[10.5px] font-semibold tracking-wider text-fg-3 uppercase">Programs & scripts · {others.length}</h3>}
      <ul>{others.map(row)}</ul>
    </div>
  );
}

// ---------------------------------------------------------------- investigations
function ChatsSection() {
  const nav = useNav();
  const convs = useAsync(() => api.conversations(nav.snapshotId), [nav.snapshotId]);
  const current = Number(nav.param("c")) || null;
  if (convs.error) return <div className="p-3"><ErrorState error={convs.error} onRetry={convs.reload} /></div>;
  if (!convs.data) return <div className="p-3"><SkeletonRows rows={4} /></div>;
  return (
    <div className="py-1">
      <button onClick={() => { nav.setParams({ c: null }); nav.setAssistantOpen(true); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-accent hover:bg-panel-3">
        <Plus className="h-3.5 w-3.5" aria-hidden /> New investigation
      </button>
      {convs.data.length === 0 && <p className="px-3 py-1 text-[12px] text-fg-3">No investigations for this commit yet. Ask the assistant a question to start one; it is saved here.</p>}
      <ul>
        {convs.data.map((c) => (
          <li key={c.id}>
            <button
              onClick={() => { nav.setParams({ c: String(c.id) }); nav.setAssistantOpen(true); }}
              className={cn("block w-full px-3 py-1.5 text-left", c.id === current ? "bg-accent-soft" : "hover:bg-panel-3")}
              aria-current={c.id === current || undefined}
            >
              <div className={cn("truncate text-[12.5px]", c.id === current && "text-accent")}>{c.title}</div>
              <div className="truncate font-mono text-[10.5px] text-fg-3">{c.model} · {formatTime(c.updated_at)}</div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
