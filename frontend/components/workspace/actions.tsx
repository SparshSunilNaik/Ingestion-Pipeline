"use client";

import { BookOpen, GitFork, Network, Play, Radar, Search } from "lucide-react";
import type { Selection } from "@/components/workspace/nav";

export type ActionId = "explain" | "usage" | "trace" | "dependencies" | "impact" | "architecture";

export const ACTIONS: Record<ActionId, { label: string; icon: typeof Search }> = {
  explain: { label: "Explain this", icon: BookOpen },
  usage: { label: "Where is this used?", icon: Search },
  trace: { label: "Trace execution", icon: Play },
  dependencies: { label: "Show dependencies", icon: GitFork },
  impact: { label: "Assess change impact", icon: Radar },
  architecture: { label: "Explain the architecture", icon: Network },
};

function where(s: Selection) {
  if (!s.path) return "";
  return s.start ? ` (${s.path}:${s.start}${s.end && s.end !== s.start ? `-${s.end}` : ""})` : ` (${s.path})`;
}

/** The exact item is named in the question so retrieval and the model focus on it. */
export function questionFor(action: ActionId, s: Selection | null): string {
  if (action === "architecture" || !s) return "Explain the architecture of this repository: its main components, how they interact, and the main entry points.";
  const name = s.kind === "file" ? `the file ${s.path ?? s.label}` : s.kind === "route" ? `the route ${s.label}` : `${s.symbolKind ?? "symbol"} ${s.label}`;
  switch (action) {
    case "explain":
      return s.kind === "file" ? `Explain the purpose of ${name} and its main components.` : `Explain what ${name}${where(s)} does and how it fits into the repository.`;
    case "usage":
      return `Where is ${name}${where(s)} used? List its direct callers and the routes or entry points that reach it.`;
    case "trace":
      return s.kind === "route" ? `What happens when a request reaches ${s.label}? Trace the execution in order.` : `Trace the execution starting at ${name}${where(s)}: what does it call, in order?`;
    case "dependencies":
      return `What does ${name}${where(s)} depend on, directly and transitively?`;
    case "impact":
      return `What could be affected if ${name}${where(s)} changes? Include routes and tests.`;
  }
}

export function actionsFor(s: Selection | null): ActionId[] {
  if (!s) return ["architecture"];
  if (s.kind === "file") return ["explain", "usage", "dependencies", "impact"];
  if (s.kind === "route") return ["trace", "impact"];
  if (s.symbolKind === "class" || s.symbolKind === "interface") return ["explain", "usage", "dependencies", "impact"];
  return ["explain", "usage", "trace", "dependencies", "impact"];
}
