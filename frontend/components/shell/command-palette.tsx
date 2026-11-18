"use client";

import { Boxes, Braces, ChevronRight, CornerDownLeft, FileCode, Hash, Library, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type RetrievalResult } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { Kbd, cn } from "@/components/ui";

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  go: () => void;
}

const PAGES = [
  ["/", "Dashboard"],
  ["/repositories", "Repositories"],
  ["/jobs", "Recent analyses"],
  ["/settings", "Settings"],
];
const VIEWS = ["overview", "code", "architecture", "investigate", "report", "compare"];

export function CommandPalette({ snapshotId, onClose }: { snapshotId: number | null; onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const repos = useAsync(() => api.repositories().catch(() => []), []);
  const hits = useAsync(
    () => (snapshotId && debounced.length >= 2 ? api.retrieve(snapshotId, debounced, 10).then((r) => r.results).catch(() => [] as RetrievalResult[]) : Promise.resolve([] as RetrievalResult[])),
    [snapshotId, debounced],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 180);
    return () => clearTimeout(t);
  }, [query]);

  const items = useMemo<Item[]>(() => {
    const ql = query.toLowerCase();
    const out: Item[] = [];
    const nav = (href: string) => () => {
      router.push(href);
      onClose();
    };
    for (const [href, label] of PAGES) if (!ql || label.toLowerCase().includes(ql)) out.push({ id: href, group: "Go to", label, icon: <ChevronRight className="h-3.5 w-3.5" />, go: nav(href) });
    if (snapshotId)
      for (const v of VIEWS)
        if (!ql || v.includes(ql)) out.push({ id: `view-${v}`, group: "Workspace", label: v[0].toUpperCase() + v.slice(1), icon: <Boxes className="h-3.5 w-3.5" />, go: nav(`/snapshots/${snapshotId}?view=${v}`) });
    for (const r of repos.data ?? []) {
      const name = `${r.owner}/${r.name}`;
      if (r.current && (!ql || name.toLowerCase().includes(ql)))
        out.push({ id: `repo-${r.id}`, group: "Repositories", label: name, hint: r.current.commit_sha.slice(0, 10), icon: <Library className="h-3.5 w-3.5" />, go: nav(`/snapshots/${r.current.id}`) });
    }
    for (const h of hits.data ?? []) {
      const icon = h.kind === "symbol" ? <Braces className="h-3.5 w-3.5" /> : h.kind === "file" ? <FileCode className="h-3.5 w-3.5" /> : <Hash className="h-3.5 w-3.5" />;
      out.push({
        id: `hit-${h.key}`,
        group: "In this repository",
        label: h.kind === "text" ? `${h.path}:${h.start_line + 3}` : h.label,
        hint: h.kind === "symbol" ? `${h.symbol_kind} · ${h.path}` : h.kind,
        icon,
        go: nav(`/snapshots/${snapshotId}?view=code&file=${encodeURIComponent(h.path)}&l=${h.start_line}-${h.end_line}${h.kind === "symbol" ? `&sym=${encodeURIComponent(h.key)}` : ""}`),
      });
    }
    return out.slice(0, 40);
  }, [query, repos.data, hits.data, snapshotId, router, onClose]);

  const safeCursor = Math.min(cursor, Math.max(0, items.length - 1));
  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[10vh]" onClick={onClose}>
      <div role="dialog" aria-modal aria-label="Command palette" className="w-[640px] max-w-[92vw] overflow-hidden rounded-lg border border-line bg-panel shadow-[var(--shadow)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex h-11 items-center gap-2 border-b border-line px-3">
          <Search className="h-4 w-4 text-fg-3" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === "Enter") {
                items[safeCursor]?.go();
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
            placeholder={snapshotId ? "Search symbols, files and code in this repository, or jump anywhere…" : "Jump to a page or repository…"}
            aria-label="Command palette search"
            className="h-full flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-fg-3"
          />
          <Kbd>Esc</Kbd>
        </div>
        <ul className="max-h-[52vh] overflow-auto py-1" role="listbox" aria-label="Results">
          {items.length === 0 && <li className="px-4 py-6 text-center text-[12.5px] text-fg-3">{hits.loading && debounced ? "Searching…" : "No matches"}</li>}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <li key={it.id} role="option" aria-selected={i === safeCursor}>
                {header && <div className="px-3 pt-2 pb-1 text-[10.5px] tracking-wider text-fg-3 uppercase">{header}</div>}
                <button
                  onMouseEnter={() => setCursor(i)}
                  onClick={it.go}
                  className={cn("flex h-8 w-full items-center gap-2.5 px-3 text-left text-[13px]", i === safeCursor ? "bg-accent-soft text-fg" : "text-fg-2")}
                >
                  <span className="text-fg-3">{it.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.hint && <span className="max-w-[45%] truncate font-mono text-[11px] text-fg-3">{it.hint}</span>}
                  {i === safeCursor && <CornerDownLeft className="h-3.5 w-3.5 text-fg-3" aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
