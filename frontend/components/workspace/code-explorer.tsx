"use client";

import { Braces, ChevronDown, ChevronRight, FileCode, Folder, FolderOpen, Network, Play, Search, ShieldQuestionMark } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Group, Panel as RPanel, Separator, useDefaultLayout } from "react-resizable-panels";
import { api, type Snapshot, type SymbolRow, type TreeFile } from "@/lib/api";
import { useAsync, useHotkey } from "@/lib/hooks";
import { Badge, Button, EmptyState, ErrorState, ResolutionBadge, SkeletonRows, Spinner, cn, formatBytes } from "@/components/ui";
import { EvidenceChip, useNav } from "@/components/workspace/nav";
import { SourceView } from "@/components/workspace/source-view";

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
      const seg = parts[i];
      let next = cur.dirs.get(seg);
      if (!next) {
        next = { name: seg, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] };
        cur.dirs.set(seg, next);
      }
      cur = next;
    }
    cur.files.push(f);
  }
  return root;
}

function parseRange(l: string | null): [number, number] | null {
  if (!l) return null;
  const [a, b] = l.split("-").map(Number);
  return Number.isFinite(a) && a > 0 ? [a, Number.isFinite(b) && b >= a ? b : a] : null;
}

export function CodeExplorer({ snapshot: s }: { snapshot: Snapshot }) {
  const nav = useNav();
  const file = nav.param("file");
  const range = parseRange(nav.param("l"));
  const tree = useAsync(() => api.tree(s.id), [s.id]);
  const layout = useDefaultLayout({ id: "ip.code.layout" });

  return (
    <Group orientation="horizontal" id="ip.code.layout" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged} className="h-full">
      <RPanel id="tree" defaultSize="22" minSize="14" className="flex min-h-0 flex-col bg-panel">
        {tree.error ? <div className="p-3"><ErrorState error={tree.error} onRetry={tree.reload} /></div> : null}
        {!tree.data && !tree.error && <div className="p-3"><SkeletonRows rows={12} /></div>}
        {tree.data && <FileTree files={tree.data.files} selected={file} onSelect={(p) => nav.openSource({ path: p })} />}
      </RPanel>
      <Separator />
      <RPanel id="source" defaultSize="53" minSize="30" className="flex min-h-0 flex-col">
        {file ? <SourcePane snapshot={s} path={file} range={range} meta={tree.data?.files.find((f) => f.p === file)} /> : (
          <EmptyState icon={<FileCode className="h-6 w-6" />} title="Select a file">Pick a file from the tree, press <code className="font-mono">/</code> to filter, or follow an evidence citation from any view.</EmptyState>
        )}
      </RPanel>
      <Separator />
      <RPanel id="inspector" defaultSize="25" minSize="16" className="flex min-h-0 flex-col bg-panel">
        {file ? <SymbolPane snapshot={s} path={file} range={range} /> : <EmptyState title="No file selected" />}
      </RPanel>
    </Group>
  );
}

function FileTree({ files, selected, onSelect }: { files: TreeFile[]; selected: string | null; onSelect: (path: string) => void }) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set([""]));
  const inputRef = useRef<HTMLInputElement>(null);
  useHotkey("/", () => inputRef.current?.focus());
  const root = useMemo(() => buildTree(files), [files]);
  const matches = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? files.filter((x) => x.p.toLowerCase().includes(f)).slice(0, 300) : null;
  }, [files, filter]);
  // auto-expand the selected file's ancestors
  const expanded = useMemo(() => {
    const set = new Set(open);
    if (selected) {
      const parts = selected.split("/");
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join("/"));
    }
    return set;
  }, [open, selected]);
  const toggle = (p: string) => setOpen((prev) => {
    const n = new Set(prev);
    if (expanded.has(p)) n.delete(p);
    else n.add(p);
    return n;
  });

  const fileRow = (f: TreeFile, depth: number, showPath = false) => (
    <li key={f.p}>
      <button
        onClick={() => f.a && onSelect(f.p)}
        disabled={!f.a}
        title={f.a ? `${f.p} · ${f.l ?? f.c} · ${formatBytes(f.s)}` : `${f.p} — not analysed (${f.x ?? f.c})`}
        className={cn(
          "flex h-[24px] w-full items-center gap-1.5 pr-2 text-left text-[12.5px]",
          selected === f.p ? "bg-accent-soft text-accent" : f.a ? "text-fg-2 hover:bg-panel-3 hover:text-fg" : "cursor-default text-fg-3/60",
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <FileCode className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
        <span className="truncate">{showPath ? f.p : f.p.split("/").pop()}</span>
        {!f.a && <span className="ml-auto shrink-0 text-[10px]">{f.x?.replaceAll("_", " ") ?? "skipped"}</span>}
      </button>
    </li>
  );

  const renderDir = (d: DirNode, depth: number): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    for (const sub of [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const isOpen = expanded.has(sub.path);
      out.push(
        <li key={`d:${sub.path}`}>
          <button onClick={() => toggle(sub.path)} aria-expanded={isOpen} className="flex h-[24px] w-full items-center gap-1 pr-2 text-left text-[12.5px] text-fg-2 hover:bg-panel-3" style={{ paddingLeft: 4 + depth * 12 }}>
            {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
            {isOpen ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-fg-3" /> : <Folder className="h-3.5 w-3.5 shrink-0 text-fg-3" />}
            <span className="truncate">{sub.name}</span>
          </button>
        </li>,
      );
      if (isOpen) out.push(...renderDir(sub, depth + 1));
    }
    for (const f of [...d.files].sort((a, b) => a.p.localeCompare(b.p))) out.push(fileRow(f, depth));
    return out;
  };

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-2">
        <Search className="h-3.5 w-3.5 text-fg-3" aria-hidden />
        <input ref={inputRef} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files  /" aria-label="Filter files" className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-3" />
        <span className="shrink-0 text-[11px] text-fg-3">{files.filter((f) => f.a).length}/{files.length}</span>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto py-1" aria-label="Repository files">
        {matches ? matches.map((f) => fileRow(f, 0, true)) : renderDir(root, 0)}
        {matches && matches.length === 0 && <li className="px-3 py-2 text-[12px] text-fg-3">No files match.</li>}
      </ul>
    </>
  );
}

function SourcePane({ snapshot: s, path, range, meta }: { snapshot: Snapshot; path: string; range: [number, number] | null; meta?: TreeFile }) {
  const nav = useNav();
  const src = useAsync(() => api.source(s.id, path), [s.id, path]);
  const syms = useAsync(() => api.symbols(s.id, { path, limit: 1000 }), [s.id, path]);
  const markers = useMemo(() => new Map((syms.data ?? []).map((x) => [x.start_line, `${x.kind} ${x.qualified_name}`])), [syms.data]);
  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 text-[12px]">
        <FileCode className="h-3.5 w-3.5 text-fg-3" aria-hidden />
        <span className="min-w-0 truncate font-mono text-fg" title={path}>{path}</span>
        {range && <Badge tone="accent">lines {range[0]}–{range[1]}</Badge>}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-fg-3">
          {src.data && <span>{src.data.total_lines} lines</span>}
          {meta && <><span>·</span><span>{meta.l ?? meta.c}</span><span>·</span><span>{formatBytes(meta.s)}</span></>}
          <span>·</span>
          <code className="font-mono" title="Snapshot commit">{s.commit_sha.slice(0, 10)}</code>
        </span>
      </div>
      <div className="min-h-0 flex-1">
        {src.error ? <div className="p-3"><ErrorState error={src.error} onRetry={src.reload} /></div> : null}
        {!src.data && !src.error && <div className="p-3"><Spinner label="Loading source" /></div>}
        {src.data && <SourceView source={src.data} highlight={range} markers={markers} onLineClick={(n) => nav.openSource({ path, start: n, end: n })} />}
      </div>
    </>
  );
}

function SymbolPane({ snapshot: s, path, range }: { snapshot: Snapshot; path: string; range: [number, number] | null }) {
  const nav = useNav();
  const syms = useAsync(() => api.symbols(s.id, { path, limit: 1000 }), [s.id, path]);
  const explicit = nav.param("sym");
  const atLine = useMemo(() => {
    if (!range || !syms.data) return null;
    const containing = syms.data.filter((x) => x.start_line <= range[0] && x.end_line >= range[0]);
    return containing.sort((a, b) => a.end_line - a.start_line - (b.end_line - b.start_line))[0] ?? null;
  }, [syms.data, range]);
  const selectedKey = explicit ?? (atLine ? `sym:${atLine.path}#${atLine.qualified_name}` : null);
  const selected = syms.data?.find((x) => `sym:${x.path}#${x.qualified_name}` === selectedKey) ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center border-b border-line px-3 text-[11.5px] font-semibold tracking-wide text-fg-2 uppercase">Outline</div>
      <div className="max-h-[38%] min-h-[80px] overflow-auto border-b border-line py-1">
        {!syms.data && <div className="p-3"><SkeletonRows rows={5} /></div>}
        {syms.data?.length === 0 && <p className="px-3 py-2 text-[12px] text-fg-3">No symbols extracted from this file.</p>}
        <ul>
          {(syms.data ?? []).map((x) => (
            <li key={x.id}>
              <button
                onClick={() => nav.openSource({ path, start: x.start_line, end: x.end_line, sym: `sym:${x.path}#${x.qualified_name}` })}
                className={cn("flex h-[24px] w-full items-center gap-1.5 pr-2 text-left text-[12.5px]", selected?.id === x.id ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-panel-3")}
                style={{ paddingLeft: 10 + (x.qualified_name.split(".").length - 1) * 12 }}
              >
                <Braces className="h-3 w-3 shrink-0" style={{ color: `var(--k-${x.kind === "method" ? "method" : x.kind === "class" || x.kind === "interface" ? "class" : "function"})` }} aria-hidden />
                <span className="truncate font-mono text-[12px]">{x.name}</span>
                <span className="ml-auto shrink-0 text-[10.5px] text-fg-3">{x.kind}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {selected ? <SymbolDetail snapshot={s} symbol={selected} /> : <p className="p-3 text-[12px] text-fg-3">Select a symbol or a line inside one to see its definition, references and dependents.</p>}
      </div>
    </div>
  );
}

function SymbolDetail({ snapshot: s, symbol }: { snapshot: Snapshot; symbol: SymbolRow }) {
  const nav = useNav();
  const key = `sym:${symbol.path}#${symbol.qualified_name}`;
  const usage = useAsync(() => api.usage(s.id, key), [s.id, key]);
  const u = usage.data;
  return (
    <div className="space-y-3 p-3 text-[12.5px]">
      <div>
        <div className="flex items-center gap-1.5">
          <Badge tone="accent">{symbol.kind}</Badge>
          {symbol.exported && <Badge>exported</Badge>}
        </div>
        <div className="mt-1 font-mono text-[12.5px] break-all">{symbol.qualified_name}</div>
        {symbol.signature && <pre className="mt-1.5 overflow-x-auto rounded bg-panel-2 p-2 font-mono text-[11.5px] whitespace-pre-wrap text-fg-2">{symbol.signature}</pre>}
        {symbol.docstring && <p className="mt-1.5 text-fg-2">{symbol.docstring}</p>}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {symbol.evidence_id && <EvidenceChip id={symbol.evidence_id} />}
          <Button size="sm" variant="ghost" onClick={() => nav.focusGraph(key, "impact")}><Network className="h-3.5 w-3.5" /> Impact</Button>
          {(symbol.kind === "function" || symbol.kind === "method") && (
            <Button size="sm" variant="ghost" onClick={() => nav.setParams({ view: "architecture", gview: "flows", entry: key })}><Play className="h-3.5 w-3.5" /> Trace calls</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => nav.ask(`Where is ${symbol.qualified_name} used, and what does it do?`)}><ShieldQuestionMark className="h-3.5 w-3.5" /> Ask</Button>
        </div>
      </div>
      {usage.error ? <ErrorState error={usage.error} compact /> : null}
      {!u && !usage.error && <SkeletonRows rows={4} />}
      {u && (
        <>
          <RelatedBlock title="Direct references" hint="Single evidence-backed edges into this symbol" items={u.direct_references.map((r) => ({ key: r.key + (r.call_line ?? ""), label: r.label, sub: r.path ?? "", resolution: r.resolution, via: r.via, ev: r.evidence_id, onClick: () => r.path && nav.openSource({ path: r.path, start: r.call_line ?? r.start_line, end: r.call_line ?? r.end_line }) }))} />
          <RelatedBlock title="Calls" items={u.direct_callees.map((r) => ({ key: r.key, label: r.label, sub: r.path ?? r.kind, resolution: r.resolution, via: r.via, ev: r.evidence_id, onClick: () => r.path && nav.openSource({ path: r.path, start: r.start_line, end: r.end_line }) }))} />
          <RelatedBlock title="Related routes" items={u.related_routes.map((r) => ({ key: r.key, label: r.label, sub: `via ${r.via}, depth ${r.depth}`, onClick: () => nav.focusGraph(r.key) }))} />
          <RelatedBlock title="Upstream (transitive)" hint="Graph reachability, depth > 1 — potential, not direct" items={u.upstream_transitive.slice(0, 20).map((r) => ({ key: r.key, label: r.label, sub: `depth ${r.depth}`, onClick: () => r.path && nav.openSource({ path: r.path, start: r.start_line, end: r.end_line }) }))} />
          {u.possible_dynamic_references.length > 0 && (
            <RelatedBlock title="Possible dynamic references" hint="Unresolved calls with the same name — NOT proven to target this symbol" items={u.possible_dynamic_references.map((r) => ({ key: r.key + (r.evidence_id ?? ""), label: r.callee_text ?? r.label, sub: r.path ?? "", resolution: "unresolved", ev: r.evidence_id }))} />
          )}
        </>
      )}
    </div>
  );
}

export function RelatedBlock({ title, hint, items }: {
  title: string;
  hint?: string;
  items: { key: string; label: string; sub?: string | null; resolution?: string; via?: string | null; ev?: string | null; onClick?: () => void }[];
}) {
  return (
    <section>
      <h3 className="mb-1 flex items-baseline gap-2 text-[11px] font-semibold tracking-wide text-fg-3 uppercase" title={hint}>
        {title} <span className="font-mono text-fg-3">{items.length}</span>
      </h3>
      {items.length === 0 ? (
        <p className="text-[12px] text-fg-3">None found.</p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((it) => (
            <li key={it.key} className="flex items-center gap-1.5">
              <button onClick={it.onClick} disabled={!it.onClick} className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left hover:bg-panel-3 disabled:hover:bg-transparent">
                <span className="font-mono text-[12px]">{it.label}</span>
                {it.sub && <span className="ml-1.5 text-[11px] text-fg-3">{it.sub}</span>}
              </button>
              {it.resolution && <ResolutionBadge resolution={it.resolution} via={it.via} />}
              {it.ev && <EvidenceChip id={it.ev} className="max-w-[120px]" />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
