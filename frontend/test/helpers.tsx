import { render } from "@testing-library/react";
import axe from "axe-core";
import type { ReactElement } from "react";
import { vi } from "vitest";
import type { Snapshot } from "@/lib/api";
import { NavContext, type WorkspaceNav } from "@/components/workspace/nav";

export const SNAPSHOT: Snapshot = {
  id: 7,
  repository_id: 1,
  commit_sha: "0123456789abcdef0123456789abcdef01234567",
  default_branch: "main",
  status: "ready",
  analyzer_version: "0.3.0",
  acquired_at: "2026-11-18T10:00:00Z",
  commit_info: { subject: "Initial commit" },
  recent_commits: [],
  coverage: { tracked_files: 4, analyzed_files: 4, analyzed_bytes: 900, eligible_text_files: 4, budget_skipped_files: 0, tracked_files_beyond_limit: 0, is_partial: false, exclusions: {}, limits: {} },
  inventory_summary: { languages_by_files: { python: 3 }, languages_by_bytes: { python: 900 }, categories: {}, documentation_files: [], test_files_count: 1, ci_files: [], container_files: [], source_directories: ["svc"], total_bytes: 900 },
  analysis_summary: {
    stats: { symbols_function: 3, symbols_class: 1 },
    graph: { nodes: 10, edges: 12, edge_kinds: {}, edge_resolution: { resolved: 10, ambiguous: 2 } },
    most_referenced_symbols: [{ key: "sym:svc/auth.py#login", label: "login", kind: "function", path: "svc/auth.py", references: 3 }],
  },
  repository: { id: 1, owner: "acme", name: "shop", canonical_url: "https://github.com/acme/shop", default_branch: "main" },
};

export function makeNav(overrides: Partial<WorkspaceNav> = {}, params: Record<string, string> = {}): WorkspaceNav {
  return {
    snapshotId: SNAPSHOT.id,
    snapshot: SNAPSHOT,
    view: "overview",
    tabs: [],
    activeTabId: "overview",
    activate: vi.fn(),
    close: vi.fn(),
    setView: vi.fn(),
    openSource: vi.fn(),
    openEvidence: vi.fn(async () => undefined),
    openSymbol: vi.fn(),
    focusGraph: vi.fn(),
    openGraph: vi.fn(),
    openFlow: vi.fn(),
    ask: vi.fn(),
    setAsker: vi.fn(),
    selection: null,
    setSelection: vi.fn(),
    assistantOpen: true,
    focusMode: false,
    toggleFocus: vi.fn(),
    setAssistantOpen: vi.fn(),
    param: (name: string) => params[name] ?? null,
    setParams: vi.fn(),
    ...overrides,
  };
}

export function renderWithNav(ui: ReactElement, nav: WorkspaceNav = makeNav()) {
  return { nav, ...render(<NavContext.Provider value={nav}>{ui}</NavContext.Provider>) };
}

/** Run axe on a rendered container. Colour contrast needs real layout and is checked in the browser suite. */
export async function axeViolations(container: Element) {
  const res = await axe.run(container, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
  return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}
