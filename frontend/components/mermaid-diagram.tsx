"use client";

import { useEffect, useId, useState } from "react";

/** Renders a Mermaid definition client-side. The definition must be built from real data by the caller. */
export function MermaidDiagram({ definition }: { definition: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral" });
        const out = await mermaid.render(`m${id}`, definition);
        if (alive) setSvg(out.svg);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [definition, id]);

  if (error) return <p className="text-sm text-bad">Diagram error: {error}</p>;
  // Mermaid output is generated with securityLevel "strict" from sanitized labels.
  return <div className="overflow-auto [&_svg]:mx-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_./@-]/g, "_").slice(0, 60) || "_";

/**
 * Build a component diagram from resolved file-to-file import edges, grouped by directory prefix.
 * The grouping depth adapts (1-3 segments) so single-root layouts such as `src/pkg/...` still show structure.
 */
export function componentDiagram(edges: { source: string; target: string; kind: string; resolution: string }[]): string | null {
  const fileEdges = edges.filter((e) => e.kind === "imports" && e.resolution === "resolved" && e.source.startsWith("file:") && e.target.startsWith("file:"));
  if (fileEdges.length === 0) return null;
  const group = (key: string, depth: number) => {
    const parts = key.slice(5).split("/");
    parts.pop();
    return parts.length === 0 ? "(root)" : parts.slice(0, depth).join("/");
  };
  let depth = 1;
  for (; depth < 3; depth++) {
    const groups = new Set(fileEdges.flatMap((e) => [group(e.source, depth), group(e.target, depth)]));
    if (groups.size >= 3) break;
  }
  const counts = new Map<string, number>();
  const dirs = new Set<string>();
  const SEP = "\u0000";
  for (const e of fileEdges) {
    const a = group(e.source, depth);
    const b = group(e.target, depth);
    dirs.add(a);
    dirs.add(b);
    if (a !== b) counts.set(a + SEP + b, (counts.get(a + SEP + b) ?? 0) + 1);
  }
  const ids = new Map([...dirs].slice(0, 40).map((d, i) => [d, `d${i}`]));
  const lines = ["flowchart LR"];
  for (const [d, id] of ids) lines.push(`  ${id}["${safe(d)}"]`);
  for (const [k, n] of counts) {
    const [a, b] = k.split(SEP);
    if (ids.has(a) && ids.has(b)) lines.push(`  ${ids.get(a)} -->|${n} imports| ${ids.get(b)}`);
  }
  return lines.join("\n");
}
