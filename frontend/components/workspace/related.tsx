"use client";

import { EvidenceChip } from "@/components/workspace/nav";
import { ResolutionBadge } from "@/components/ui";

export interface RelatedItem {
  key: string;
  label: string;
  sub?: string | null;
  resolution?: string;
  via?: string | null;
  ev?: string | null;
  onClick?: () => void;
}

/** A titled list of related code items (callers, callees, dependents…) with resolution and evidence. */
export function RelatedBlock({ title, hint, items, empty = "None found.", limit }: { title: string; hint?: string; items: RelatedItem[]; empty?: string; limit?: number }) {
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <section>
      <h3 className="mb-1 flex items-baseline gap-2 text-[11px] font-semibold tracking-wide text-fg-3 uppercase" title={hint}>
        {title} <span className="font-mono">{items.length}</span>
      </h3>
      {hint && <p className="mb-1 text-[11px] text-fg-3">{hint}</p>}
      {items.length === 0 ? (
        <p className="text-[12px] text-fg-3">{empty}</p>
      ) : (
        <ul className="space-y-0.5">
          {shown.map((it) => (
            <li key={it.key} className="rounded px-1 py-0.5 hover:bg-panel-2">
              <button onClick={it.onClick} disabled={!it.onClick} className="block w-full min-w-0 truncate text-left font-mono text-[12px] hover:text-accent disabled:hover:text-fg" title={it.sub ? `${it.label} — ${it.sub}` : it.label}>
                {it.label}
              </button>
              {(it.sub || it.resolution || it.ev) && (
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                  {it.resolution && <ResolutionBadge resolution={it.resolution} via={it.via} />}
                  {it.sub && <span className="min-w-0 truncate text-[11px] text-fg-3">{it.sub}</span>}
                  {it.ev && <EvidenceChip id={it.ev} className="ml-auto max-w-[150px] shrink-0" />}
                </div>
              )}
            </li>
          ))}
          {limit && items.length > limit && <li className="px-1 text-[11px] text-fg-3">+{items.length - limit} more</li>}
        </ul>
      )}
    </section>
  );
}
