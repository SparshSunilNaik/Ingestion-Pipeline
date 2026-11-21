"use client";

import { ArrowDown, ArrowUp, Braces, ChevronRight, FileCode, Link2, Network, PanelRightClose, PanelRightOpen, Search, X } from "lucide-react";
import { toast } from "@/components/shell/toaster";
import { useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { api, type SymbolRow } from "@/lib/api";
import { useAsync, useHotkey, usePref } from "@/lib/hooks";
import { ACTIONS, type ActionId, actionsFor, questionFor } from "@/components/workspace/actions";
import { EvidenceChip, type Selection, useNav } from "@/components/workspace/nav";
import { RelatedBlock } from "@/components/workspace/related";
import { SourceView } from "@/components/workspace/source-view";
import { Badge, Button, EmptyState, ErrorState, IconButton, SkeletonRows, Spinner, cn, formatBytes } from "@/components/ui";

export function parseRange(l: string | null): [number, number] | null {
  if (!l) return null;
  const [a, b] = l.split("-").map(Number);
  return Number.isFinite(a) && a > 0 ? [a, Number.isFinite(b) && b >= a ? b : a] : null;
}

export const symKey = (x: { path: string; qualified_name: string }) => `sym:${x.path}#${x.qualified_name}`;

export function FileTab() {
  const nav = useNav();
  const path = nav.param("file");
  const [inspector, setInspector] = usePref("ip.file.inspector", "open");
  const layout = useDefaultLayout({ id: "ip.file.layout" });
  if (!path) {
    return (
      <EmptyState icon={<FileCode className="h-6 w-6" />} title="Open a file">
        Choose a file in the explorer, search with <kbd className="font-mono">/</kbd>, or follow any citation — it opens here at the exact lines.
      </EmptyState>
    );
  }
  return (
    <Group orientation="horizontal" id="ip.file.layout" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged} className="h-full">
      <Panel id="source" defaultSize="66" minSize="40" className="flex min-h-0 min-w-0 flex-col">
        <SourcePane key={path} path={path} inspectorOpen={inspector === "open"} onToggleInspector={() => setInspector(inspector === "open" ? "closed" : "open")} />
      </Panel>
      {inspector === "open" && (
        <>
          <Separator aria-label="Resize symbol inspector" />
          <Panel id="inspector" defaultSize="34" minSize="22" className="flex min-h-0 flex-col bg-panel">
            <SymbolPane key={path} path={path} />
          </Panel>
        </>
      )}
    </Group>
  );
}

function SourcePane({ path, inspectorOpen, onToggleInspector }: { path: string; inspectorOpen: boolean; onToggleInspector: () => void }) {
  const nav = useNav();
  const s = nav.snapshot;
  const range = parseRange(nav.param("l"));
  const src = useAsync(() => api.source(s.id, path), [s.id, path]);
  const syms = useAsync(() => api.symbols(s.id, { path, limit: 1000 }), [s.id, path]);
  const tree = useAsync(() => api.tree(s.id), [s.id]);
  const meta = tree.data?.files.find((f) => f.p === path);
  const markers = useMemo(() => new Map((syms.data ?? []).map((x) => [x.start_line, `${x.kind} ${x.qualified_name}`])), [syms.data]);
  // Sticky context: the innermost symbol that contains the first visible line.
  const [topLine, setTopLine] = useState(1);
  const enclosing = useMemo(() => {
    const inside = (syms.data ?? []).filter((x) => x.start_line < topLine && x.end_line >= topLine);
    return inside.sort((a, b) => a.end_line - a.start_line - (b.end_line - b.start_line))[0] ?? null;
  }, [syms.data, topLine]);
  // Alt+Down / Alt+Up jump between symbol definitions.
  const ordered = useMemo(() => [...(syms.data ?? [])].sort((a, b) => a.start_line - b.start_line), [syms.data]);
  const jump = (dir: 1 | -1) => {
    const from = range?.[0] ?? topLine;
    const next = dir === 1 ? ordered.find((x) => x.start_line > from) : [...ordered].reverse().find((x) => x.start_line < from);
    if (next) nav.openSource({ path, start: next.start_line, end: next.end_line, sym: symKey(next) });
  };
  useHotkey("alt+arrowdown", () => jump(1));
  useHotkey("alt+arrowup", () => jump(-1));

  const [findOpen, setFindOpen] = useState(false);
  const [find, setFind] = useState("");
  const [cursor, setCursor] = useState(0);
  const findRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    const q = find.trim().toLowerCase();
    if (!q || !src.data) return [] as number[];
    return src.data.lines.flatMap((line, i) => (line.toLowerCase().includes(q) ? [src.data!.start_line + i] : []));
  }, [find, src.data]);
  const current = matches.length ? matches[Math.min(cursor, matches.length - 1)] : null;
  useHotkey("mod+f", () => {
    setFindOpen(true);
    setTimeout(() => findRef.current?.select(), 0);
  }, { allowInInputs: true });

  // Path breadcrumbs open the containing directory as a filtered architecture view.
  const parts = path.split("/");
  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 text-[12px]">
        <nav aria-label="File path" className="flex min-w-0 items-center gap-0.5 font-mono">
          {parts.map((p, i) => (
            <span key={i} className="flex min-w-0 items-center gap-0.5">
              {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-fg-3" aria-hidden />}
              {i < parts.length - 1 ? (
                <button className="truncate text-fg-3 hover:text-accent" title={`Show ${parts.slice(0, i + 1).join("/")} in the architecture graph`} onClick={() => nav.openGraph({ gview: "files", prefix: parts.slice(0, i + 1).join("/") })}>
                  {p}
                </button>
              ) : (
                <span className="truncate text-fg">{p}</span>
              )}
            </span>
          ))}
        </nav>
        {range && <Badge tone="accent">lines {range[0]}–{range[1]}</Badge>}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-fg-3">
          {src.data && <span>{src.data.total_lines} lines</span>}
          {meta && <span className="hidden lg:inline">· {meta.l ?? meta.c} · {formatBytes(meta.s)}</span>}
          <IconButton
            label="Copy a link to these lines"
            onClick={() => {
              void navigator.clipboard?.writeText(window.location.href).then(() => toast(range ? `Link to ${path.split("/").pop()}:${range[0]} copied` : "Link copied"), () => undefined);
            }}
          >
            <Link2 className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="Find in file (Ctrl+F)" onClick={() => { setFindOpen(!findOpen); setTimeout(() => findRef.current?.focus(), 0); }} active={findOpen}>
            <Search className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label={inspectorOpen ? "Hide symbol inspector" : "Show symbol inspector"} onClick={onToggleInspector}>
            {inspectorOpen ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}
          </IconButton>
        </span>
      </div>
      {findOpen && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel-2 px-3" role="search">
          <Search className="h-3.5 w-3.5 text-fg-3" aria-hidden />
          <input
            ref={findRef}
            value={find}
            onChange={(e) => { setFind(e.target.value); setCursor(0); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches.length) setCursor((c) => (e.shiftKey ? (c - 1 + matches.length) % matches.length : (c + 1) % matches.length));
              if (e.key === "Escape") setFindOpen(false);
            }}
            placeholder="Find in this file"
            aria-label="Find in this file"
            className="h-7 min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-3"
          />
          <span className="shrink-0 text-[11.5px] text-fg-3" aria-live="polite">{find ? (matches.length ? `${Math.min(cursor, matches.length - 1) + 1} of ${matches.length} lines` : "no matches") : ""}</span>
          <IconButton label="Previous match (Shift+Enter)" disabled={!matches.length} onClick={() => setCursor((c) => (c - 1 + matches.length) % matches.length)}><ArrowUp className="h-3.5 w-3.5" /></IconButton>
          <IconButton label="Next match (Enter)" disabled={!matches.length} onClick={() => setCursor((c) => (c + 1) % matches.length)}><ArrowDown className="h-3.5 w-3.5" /></IconButton>
          <IconButton label="Close find" onClick={() => setFindOpen(false)}><X className="h-3.5 w-3.5" /></IconButton>
        </div>
      )}
      {enclosing && (
        <button
          type="button"
          onClick={() => nav.openSource({ path, start: enclosing.start_line, end: enclosing.end_line, sym: symKey(enclosing) })}
          className="atlas-fade flex h-7 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 text-left"
          title="You are inside this definition. Click to select it. Alt+Up/Down jumps between definitions."
        >
          <span className="atlas-label">in</span>
          <span className="truncate font-mono text-[11.5px] text-fg">{enclosing.qualified_name}</span>
          <span className="font-mono text-[10.5px] text-fg-3">{enclosing.kind} · {enclosing.start_line}–{enclosing.end_line}</span>
        </button>
      )}
      <div className="min-h-0 flex-1">
        {src.error ? (
          <div className="p-3">
            <ErrorState error={src.error} onRetry={src.reload} />
            <p className="mt-2 text-[12px] text-fg-3">Only analysed text files of this snapshot can be opened. Files excluded by the analysis limits are listed greyed out in the explorer.</p>
          </div>
        ) : null}
        {!src.data && !src.error && <div className="p-3"><Spinner label="Loading source" /></div>}
        {src.data && (
          <SourceView
            source={src.data}
            highlight={range}
            markers={markers}
            findLines={findOpen ? new Set(matches) : undefined}
            currentFind={findOpen ? current : null}
            onLineClick={(n) => nav.setParams({ l: `${n}-${n}`, sym: null })}
            onTopLine={setTopLine}
          />
        )}
      </div>
    </>
  );
}

function SymbolPane({ path }: { path: string }) {
  const nav = useNav();
  const s = nav.snapshot;
  const range = parseRange(nav.param("l"));
  const syms = useAsync(() => api.symbols(s.id, { path, limit: 1000 }), [s.id, path]);
  const explicit = nav.param("sym");
  const atLine = useMemo(() => {
    if (!range || !syms.data) return null;
    const containing = syms.data.filter((x) => x.start_line <= range[0] && x.end_line >= range[0]);
    return containing.sort((a, b) => a.end_line - a.start_line - (b.end_line - b.start_line))[0] ?? null;
  }, [syms.data, range]);
  const selectedKey = explicit ?? (atLine ? symKey(atLine) : null);
  const selected = syms.data?.find((x) => symKey(x) === selectedKey) ?? null;

  const { setSelection } = nav;
  useEffect(() => {
    if (selected) {
      setSelection({ kind: "symbol", key: symKey(selected), label: selected.qualified_name, path, start: selected.start_line, end: selected.end_line, symbolKind: selected.kind });
    } else {
      setSelection({ kind: "file", key: `file:${path}`, label: path.split("/").pop() ?? path, path });
    }
  }, [selected, path, setSelection]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center border-b border-line px-3 text-[11px] font-semibold tracking-wide text-fg-2 uppercase">Outline</div>
      <div className="max-h-[34%] min-h-[72px] overflow-auto border-b border-line py-1">
        {!syms.data && <div className="p-3"><SkeletonRows rows={5} /></div>}
        {syms.data?.length === 0 && <p className="px-3 py-2 text-[12px] text-fg-3">No symbols were extracted from this file (configuration, documentation, or an unsupported language).</p>}
        <ul aria-label="Symbols in this file">
          {(syms.data ?? []).map((x) => (
            <li key={x.id}>
              <button
                onClick={() => nav.openSource({ path, start: x.start_line, end: x.end_line, sym: symKey(x) })}
                aria-current={selected?.id === x.id || undefined}
                className={cn("flex h-[24px] w-full items-center gap-1.5 pr-2 text-left text-[12.5px]", selected?.id === x.id ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-panel-3")}
                style={{ paddingLeft: 10 + (x.qualified_name.split(".").length - 1) * 12 }}
              >
                <Braces className="h-3 w-3 shrink-0" style={{ color: `var(--k-${x.kind === "method" ? "method" : ["class", "interface", "enum"].includes(x.kind) ? "class" : "function"})` }} aria-hidden />
                <span className="truncate font-mono text-[12px]">{x.name}</span>
                <span className={cn("ml-auto shrink-0 text-[10.5px]", selected?.id === x.id ? "text-fg-2" : "text-fg-3")}>{x.kind}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {selected ? (
          <SymbolDetail symbol={selected} />
        ) : (
          <FileDetail path={path} />
        )}
      </div>
    </div>
  );
}

function ContextActions({ selection }: { selection: Selection }) {
  const nav = useNav();
  const run = (a: ActionId) => {
    if (a === "trace" && selection.kind === "symbol") return nav.openFlow(selection.key);
    if (a === "impact") return nav.openSymbol(selection.key, "impact");
    if (a === "dependencies") return nav.openSymbol(selection.key, "dependencies");
    if (a === "usage") return nav.openSymbol(selection.key, "usage");
    nav.ask(questionFor(a, selection), { send: true });
  };
  return (
    <div className="flex flex-wrap gap-1">
      {actionsFor(selection).map((a) => {
        const A = ACTIONS[a];
        return (
          <Button key={a} size="sm" variant={a === "explain" ? "secondary" : "ghost"} onClick={() => run(a)} title={a === "explain" ? "Ask the assistant (answer cites source lines)" : `${A.label} — deterministic analysis`}>
            <A.icon className="h-3.5 w-3.5" aria-hidden /> {A.label}
          </Button>
        );
      })}
    </div>
  );
}

function SymbolDetail({ symbol }: { symbol: SymbolRow }) {
  const nav = useNav();
  const key = symKey(symbol);
  const usage = useAsync(() => api.usage(nav.snapshotId, key), [nav.snapshotId, key]);
  const u = usage.data;
  const selection: Selection = { kind: "symbol", key, label: symbol.qualified_name, path: symbol.path, start: symbol.start_line, end: symbol.end_line, symbolKind: symbol.kind };
  const open = (r: { path: string | null; start_line: number | null; end_line: number | null; call_line?: number | null }, sym?: string) =>
    r.path && nav.openSource({ path: r.path, start: r.call_line ?? r.start_line, end: r.call_line ?? r.end_line, sym });
  return (
    <div className="space-y-3 p-3 text-[12.5px]">
      <div>
        <div className="flex items-center gap-1.5">
          <Badge tone="accent">{symbol.kind}</Badge>
          {symbol.exported && <Badge>exported</Badge>}
          <span className="ml-auto">{symbol.evidence_id && <EvidenceChip id={symbol.evidence_id} />}</span>
        </div>
        <div className="mt-1 font-mono text-[13px] break-all">{symbol.qualified_name}</div>
        {symbol.signature && <pre className="mt-1.5 overflow-x-auto rounded bg-panel-2 p-2 font-mono text-[11.5px] whitespace-pre-wrap text-fg-2">{symbol.signature}</pre>}
        {symbol.docstring && <p className="mt-1.5 text-fg-2">{symbol.docstring}</p>}
        <div className="mt-2">
          <ContextActions selection={selection} />
        </div>
      </div>
      {usage.error ? <ErrorState error={usage.error} compact onRetry={usage.reload} /> : null}
      {!u && !usage.error && <SkeletonRows rows={4} />}
      {u && (
        <>
          <RelatedBlock
            title="Callers & references"
            items={u.direct_references.map((r) => ({ key: r.key + (r.call_line ?? ""), label: r.label, sub: `${r.path ?? ""}${r.call_line ? `:${r.call_line}` : ""}`, resolution: r.resolution, via: r.via, ev: r.evidence_id, onClick: () => open(r, r.key.startsWith("sym:") ? r.key : undefined) }))}
            empty="No resolved callers. It may be an entry point, unused, or called dynamically."
          />
          <RelatedBlock
            title="Calls"
            items={u.direct_callees.map((r) => ({ key: r.key, label: r.label, sub: r.path ?? r.kind, resolution: r.resolution, via: r.via, ev: r.evidence_id, onClick: r.path ? () => open(r, r.key.startsWith("sym:") ? r.key : undefined) : undefined }))}
          />
          {u.related_routes.length > 0 && (
            <RelatedBlock title="Reached from routes" items={u.related_routes.map((r) => ({ key: r.key, label: r.label, sub: `${r.depth} hop${r.depth === 1 ? "" : "s"}`, onClick: () => nav.openFlow(r.key) }))} />
          )}
          {u.possible_dynamic_references.length > 0 && (
            <RelatedBlock
              title="Possible dynamic references"
              hint="Unresolved calls with the same name — not proven to target this symbol."
              items={u.possible_dynamic_references.map((r) => ({ key: r.key + (r.evidence_id ?? ""), label: r.callee_text ?? r.label, sub: r.path ?? "", resolution: "unresolved", ev: r.evidence_id }))}
            />
          )}
          <Button size="sm" variant="ghost" onClick={() => nav.openGraph({ gview: "focus", focus: key, node: key })}>
            <Network className="h-3.5 w-3.5" aria-hidden /> Show neighbourhood in graph
          </Button>
        </>
      )}
    </div>
  );
}

function FileDetail({ path }: { path: string }) {
  const nav = useNav();
  const key = `file:${path}`;
  const usage = useAsync(() => api.usage(nav.snapshotId, key), [nav.snapshotId, key]);
  const u = usage.data;
  const selection: Selection = { kind: "file", key, label: path.split("/").pop() ?? path, path };
  return (
    <div className="space-y-3 p-3 text-[12.5px]">
      <p className="text-fg-3">Select a symbol in the outline or click a line inside one to inspect it. File-level relationships:</p>
      <ContextActions selection={selection} />
      {usage.error ? <ErrorState error={usage.error} compact /> : null}
      {!u && !usage.error && <SkeletonRows rows={3} />}
      {u && (
        <>
          <RelatedBlock title="Imported by" items={u.importing_files.map((r) => ({ key: r.key, label: r.label, resolution: r.resolution, ev: r.evidence_id, onClick: () => r.path && nav.openSource({ path: r.path }) }))} empty="No analysed file imports this one." />
          <RelatedBlock title="Imports" items={(u.imports ?? []).map((r) => ({ key: r.key, label: r.kind === "file" ? (r.path ?? r.label) : r.label, sub: r.kind === "file" ? undefined : r.kind, resolution: r.resolution, ev: r.evidence_id, onClick: r.kind === "file" && r.path ? () => nav.openSource({ path: r.path as string }) : undefined }))} empty="No imports were resolved for this file." />
          {u.direct_callees.length > 0 && (
            <RelatedBlock title="Module-level calls" items={u.direct_callees.map((r) => ({ key: r.key + (r.call_line ?? ""), label: r.label, sub: r.path ?? r.kind, resolution: r.resolution, via: r.via, ev: r.evidence_id, onClick: r.path ? () => nav.openSource({ path: r.path as string, start: r.start_line, end: r.end_line }) : undefined }))} />
          )}
        </>
      )}
    </div>
  );
}
