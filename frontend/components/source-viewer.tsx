"use client";

import { useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { ErrorBox, Spinner, cn } from "@/components/ui";

/** Shows a file of the snapshot with the highlighted evidence range (start..end). */
export function SourceViewer({ snapshotId, path, start, end }: { snapshotId: number; path: string; start?: number; end?: number }) {
  const src = useAsync(() => api.source(snapshotId, path), [snapshotId, path]);
  const highlightRef = useRef<HTMLTableRowElement | null>(null);

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ block: "center" });
  }, [src.data, start]);

  if (src.error) return <ErrorBox error={src.error} />;
  if (!src.data) return <Spinner label="Loading source" />;
  const s = src.data;
  const lo = start ?? 0;
  const hi = end ?? start ?? 0;
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border bg-surface-2 px-3 py-1.5 text-xs">
        <span className="font-mono">{s.path}</span>
        <span className="text-muted">
          {s.total_lines} lines{start ? ` · highlighting ${lo}–${hi}` : ""}
        </span>
      </div>
      <div className="max-h-[70vh] overflow-auto bg-code">
        <table className="w-full border-collapse font-mono text-xs leading-5">
          <tbody>
            {s.lines.map((line, i) => {
              const n = s.start_line + i;
              const hit = n >= lo && n <= hi && lo > 0;
              return (
                <tr key={n} ref={n === lo ? highlightRef : undefined} className={cn(hit && "bg-accent-soft")}>
                  <td className="w-12 select-none border-r border-border px-2 text-right text-muted">{n}</td>
                  <td className="whitespace-pre px-3">{line || " "}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
