"use client";

import { useMemo } from "react";
import { api, type GraphView } from "@/lib/api";
import { useAsync } from "@/lib/hooks";

interface Placed {
  key: string;
  label: string;
  x: number;
  y: number;
  r: number;
  hub: boolean;
}

/** Deterministic concentric layout: the most connected directories sit in the middle. No physics, no loop. */
function place(g: GraphView, w: number, h: number): { nodes: Placed[]; edges: [Placed, Placed][] } {
  const degree = new Map<string, number>();
  for (const e of g.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + e.count);
    degree.set(e.target, (degree.get(e.target) ?? 0) + e.count);
  }
  const connected = new Set(g.edges.flatMap((e) => [e.source, e.target]));
  const sorted = [...g.nodes].filter((n) => connected.has(n.key) && n.kind !== "package")
    .sort((a, b) => (degree.get(b.key) ?? 0) - (degree.get(a.key) ?? 0)).slice(0, 18);
  const cx = w * 0.44;
  const cy = h / 2;
  const rings = [0, 0.27, 0.42];
  const perRing = [1, 6, 11];
  const placed: Placed[] = [];
  let i = 0;
  for (let ring = 0; ring < rings.length && i < sorted.length; ring++) {
    const count = Math.min(perRing[ring], sorted.length - i);
    for (let k = 0; k < count; k++, i++) {
      const n = sorted[i];
      const angle = (k / count) * Math.PI * 2 + ring * 0.6 - Math.PI / 2;
      const rr = rings[ring] * Math.min(w, h) * 1.05;
      placed.push({
        key: n.key,
        label: n.label.split("/").pop() ?? n.label,
        x: cx + Math.cos(angle) * rr * 1.1,
        y: cy + Math.sin(angle) * rr,
        r: 3 + Math.min(6, Math.sqrt(degree.get(n.key) ?? 0)),
        hub: ring === 0,
      });
    }
  }
  const byKey = new Map(placed.map((p) => [p.key, p]));
  const edges: [Placed, Placed][] = [];
  for (const e of g.edges) {
    const a = byKey.get(e.source);
    const b = byKey.get(e.target);
    if (a && b && a !== b) edges.push([a, b]);
  }
  return { nodes: placed, edges };
}

/**
 * The landing motif: the real directory map of the last explored snapshot (resolved imports between
 * directories). Drawn once with a short reveal; nothing animates afterwards.
 */
export function HeroMap({ snapshotId, caption }: { snapshotId: number | null; caption?: string }) {
  const graph = useAsync(() => (snapshotId ? api.graphView(snapshotId, { view: "files", limit: 40 }) : Promise.resolve(null)), [snapshotId]);
  const W = 520;
  const H = 360;
  const laid = useMemo(() => (graph.data && graph.data.nodes.length > 1 ? place(graph.data, W, H) : null), [graph.data]);
  if (!snapshotId || (graph.data && !laid) || graph.error) return <AbstractMap />;
  if (!laid) return <div className="aspect-[13/9] w-full" aria-hidden />;
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible" role="img" aria-label={`Import map of ${laid.nodes.length} files and ${laid.edges.length} resolved imports`}>
        <g>
          {laid.edges.map(([a, b], i) => (
            <line
              key={i}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={a.hub || b.hub ? "var(--accent)" : "var(--support)"}
              strokeOpacity={a.hub || b.hub ? 0.55 : 0.28}
              strokeWidth={1}
              className="atlas-draw"
              style={{ animationDelay: `${120 + i * 18}ms` }}
            />
          ))}
        </g>
        {laid.nodes.map((n, i) => (
          <g key={n.key} className="atlas-fade" style={{ animationDelay: `${60 + i * 30}ms` }}>
            {n.hub && <circle cx={n.x} cy={n.y} r={n.r + 9} fill="var(--accent)" opacity={0.08} />}
            <circle cx={n.x} cy={n.y} r={n.r} fill={n.hub ? "var(--accent)" : "var(--bg)"} stroke={n.hub ? "var(--accent)" : "var(--support)"} strokeWidth={1.2} />
            <text x={n.x + n.r + 5} y={n.y + 3.5} fill={n.hub ? "var(--fg)" : "var(--fg-3)"} fontSize={n.hub ? 11 : 9.5} fontFamily="var(--font-mono)">
              {n.label}
            </text>
          </g>
        ))}
      </svg>
      {caption && <figcaption className="mt-2 font-mono text-[10.5px] tracking-[0.08em] text-fg-3 uppercase">{caption}</figcaption>}
    </figure>
  );
}

/** First run: an abstract, label-free figure — it does not pretend to be a repository. */
function AbstractMap() {
  const pts = [
    [260, 180], [150, 110], [370, 100], [410, 230], [300, 290], [140, 250], [80, 170], [450, 150], [220, 60], [340, 210],
  ];
  const links = [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [1, 6], [1, 8], [2, 7], [3, 9], [4, 9], [5, 6], [2, 8]];
  return (
    <svg viewBox="0 0 520 360" className="w-full" role="img" aria-label="Abstract map motif">
      {links.map(([a, b], i) => (
        <line key={i} x1={pts[a][0]} y1={pts[a][1]} x2={pts[b][0]} y2={pts[b][1]} stroke="var(--support)" strokeOpacity={0.3} className="atlas-draw" style={{ animationDelay: `${i * 40}ms` }} />
      ))}
      {pts.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i === 0 ? 7 : 3.5} fill={i === 0 ? "var(--accent)" : "var(--bg)"} stroke={i === 0 ? "var(--accent)" : "var(--support)"} className="atlas-fade" style={{ animationDelay: `${i * 50}ms` }} />
      ))}
    </svg>
  );
}
