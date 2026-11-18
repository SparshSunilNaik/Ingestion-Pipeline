"use client";

import { useEffect, useId, useState } from "react";
import type { GraphView } from "@/lib/api";
import { usePref } from "@/lib/hooks";

/** Renders a Mermaid definition client-side (securityLevel "strict"); the definition is built from real graph data. */
export function MermaidDiagram({ definition }: { definition: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [theme] = usePref("ip.theme", "dark");
  const [out, setOut] = useState<{ svg: string; error: string | null }>({ svg: "", error: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "light" ? "neutral" : "dark",
          fontFamily: "inherit",
          themeVariables: { fontSize: "12px" },
          flowchart: { nodeSpacing: 18, rankSpacing: 36, padding: 6, useMaxWidth: true },
        });
        const r = await mermaid.render(`m${id}${theme}`, definition);
        if (alive) setOut({ svg: r.svg, error: null });
      } catch (e) {
        if (alive) setOut({ svg: "", error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [definition, id, theme]);

  if (out.error) return <p className="text-[12px] text-bad">Diagram error: {out.error}</p>;
  // Mermaid output is generated with securityLevel "strict" from sanitized labels.
  return <div className="max-h-[440px] overflow-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-h-[420px] [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: out.svg }} />;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_./@-]/g, "_").slice(0, 48) || "_";

/** Directory-level component diagram from the backend "modules" projection (resolved imports only). */
export function moduleDiagram(view: GraphView, maxNodes = 18): string | null {
  const nodes = [...view.nodes].sort((a, b) => (b.files ?? 0) - (a.files ?? 0)).slice(0, maxNodes);
  const keep = new Set(nodes.map((n) => n.key));
  const edges = view.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  if (!edges.length) return null;
  const used = new Set(edges.flatMap((e) => [e.source, e.target]));
  const ids = new Map([...used].map((k, i) => [k, `n${i}`]));
  const lines = ["flowchart LR"];
  for (const n of nodes) if (used.has(n.key)) lines.push(`  ${ids.get(n.key)}["${safe(n.label)} (${n.files ?? 0})"]`);
  for (const e of edges) lines.push(e.count > 1 ? `  ${ids.get(e.source)} -->|${e.count}| ${ids.get(e.target)}` : `  ${ids.get(e.source)} --> ${ids.get(e.target)}`);
  return lines.join("\n");
}
