import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewNode } from "@/lib/api";
import { Architecture, defaultGraphView } from "@/components/workspace/architecture";
import { SNAPSHOT, axeViolations, makeNav, renderWithNav } from "./helpers";

const api = vi.hoisted(() => ({ graphView: vi.fn(), usage: vi.fn(), retrieve: vi.fn(), evidence: vi.fn() }));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api }));

// React Flow needs real layout; the canvas is replaced by a list that exposes the same callbacks.
vi.mock("@/components/workspace/graph-canvas", () => ({
  KIND_VAR: {},
  GraphLegend: () => null,
  GraphCanvas: ({ nodes, onSelect, onOpen }: { nodes: ViewNode[]; onSelect: (k: string) => void; onOpen?: (n: ViewNode) => void }) => (
    <ul aria-label="graph">
      {nodes.map((n) => (
        <li key={n.key}>
          <button onClick={() => onSelect(n.key)} onDoubleClick={() => onOpen?.(n)}>{n.label}</button>
        </li>
      ))}
    </ul>
  ),
}));

beforeEach(() => {
  api.graphView.mockResolvedValue({
    view: "modules",
    truncated: false,
    nodes: [
      { key: "dir:svc/api", kind: "module", label: "svc/api", path: "svc/api", start_line: null, end_line: null, files: 2 },
      { key: "dir:svc/core", kind: "module", label: "svc/core", path: "svc/core", start_line: null, end_line: null, files: 3 },
      { key: "dir:docs", kind: "module", label: "docs", path: "docs", start_line: null, end_line: null, files: 1 },
    ],
    edges: [{ source: "dir:svc/api", target: "dir:svc/core", kind: "imports", resolution: "resolved", count: 4, evidence_id: "ev_1" }],
  });
  api.usage.mockResolvedValue({ definition: { key: "sym:svc/auth.py#login", kind: "function", label: "login", path: "svc/auth.py", start_line: 4, end_line: 9, evidence_id: null }, direct_references: [], importing_files: [], direct_callees: [], related_routes: [], upstream_transitive: [], downstream_transitive: [], possible_dynamic_references: [], notes: [] });
});

describe("Architecture explorer", () => {
  it("starts small repositories at the file level and larger ones at directories", () => {
    expect(defaultGraphView(SNAPSHOT)).toBe("files");
    expect(defaultGraphView({ ...SNAPSHOT, inventory_summary: { ...SNAPSHOT.inventory_summary, source_directories: ["a", "b", "c", "d"] } })).toBe("modules");
  });

  it("hides unconnected nodes by default and can show them", async () => {
    const user = userEvent.setup();
    renderWithNav(<Architecture snapshot={SNAPSHOT} />, makeNav({}, { gview: "modules" }));
    expect(await screen.findByRole("button", { name: "svc/api" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "docs" })).toBeNull();
    expect(screen.getByText("2 of 3 nodes · 1 relationships")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /hide unconnected/ }));
    expect(screen.getByRole("button", { name: "docs" })).toBeInTheDocument();
  });

  it("filters relationships by resolution", async () => {
    const user = userEvent.setup();
    renderWithNav(<Architecture snapshot={SNAPSHOT} />, makeNav({}, { gview: "modules" }));
    await screen.findByRole("button", { name: "svc/api" });
    await user.click(screen.getByRole("button", { name: /Filters/ }));
    await user.click(screen.getByRole("checkbox", { name: "resolved" }));
    expect(screen.getByText(/Every node is unconnected/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Filters \(1 hidden\)/ })).toBeInTheDocument();
  });

  it("selects a node on click and drills into a directory on double-click", async () => {
    const user = userEvent.setup();
    const { nav } = renderWithNav(<Architecture snapshot={SNAPSHOT} />, makeNav({}, { gview: "modules" }));
    await user.click(await screen.findByRole("button", { name: "svc/core" }));
    expect(nav.setParams).toHaveBeenCalledWith({ node: "dir:svc/core" });
    await user.dblClick(screen.getByRole("button", { name: "svc/core" }));
    expect(nav.setParams).toHaveBeenCalledWith({ gview: "files", prefix: "svc/core", node: null });
  });

  it("shows an inspector with next actions for the selected symbol", async () => {
    const user = userEvent.setup();
    const { nav, container } = renderWithNav(<Architecture snapshot={SNAPSHOT} />, makeNav({}, { gview: "modules", node: "sym:svc/auth.py#login" }));
    expect(await screen.findByText("Used by")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Impact/ }));
    expect(nav.openSymbol).toHaveBeenCalledWith("sym:svc/auth.py#login", "impact");
    await user.click(screen.getByRole("button", { name: /Trace/ }));
    expect(nav.openFlow).toHaveBeenCalledWith("sym:svc/auth.py#login");
    expect(nav.setSelection).toHaveBeenCalledWith(expect.objectContaining({ key: "sym:svc/auth.py#login", kind: "symbol" }));
    expect(await axeViolations(container)).toEqual([]);
  });

  it("explains an empty routes view instead of showing a blank canvas", async () => {
    api.graphView.mockResolvedValue({ view: "routes", truncated: false, nodes: [], edges: [] });
    renderWithNav(<Architecture snapshot={SNAPSHOT} />, makeNav({}, { gview: "routes" }));
    expect(await screen.findByText("No API routes were detected in this snapshot.")).toBeInTheDocument();
  });
});
