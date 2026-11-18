import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Explorer } from "@/components/workspace/explorer";
import { axeViolations, makeNav, renderWithNav } from "./helpers";

const api = vi.hoisted(() => ({
  tree: vi.fn(),
  retrieve: vi.fn(),
  symbols: vi.fn(),
  entryPoints: vi.fn(),
  conversations: vi.fn(),
}));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api }));

beforeEach(() => {
  api.tree.mockResolvedValue({
    files: [
      { p: "svc/auth.py", c: "source", l: "python", a: true, s: 300, n: 20, x: null },
      { p: "svc/models.py", c: "source", l: "python", a: true, s: 400, n: 30, x: null },
      { p: "assets/logo.png", c: "binary", l: null, a: false, s: 900, n: null, x: "binary" },
      { p: "README.md", c: "documentation", l: "markdown", a: true, s: 100, n: 5, x: null },
    ],
  });
  api.entryPoints.mockResolvedValue([
    { kind: "route", label: "POST /login", framework: "FastAPI", start_key: "route:POST /login@svc/app.py:8", evidence_id: "ev_1", traceable: true },
    { kind: "python_main_guard", label: "svc/app.py", start_key: null, evidence_id: null, traceable: false },
  ]);
  api.conversations.mockResolvedValue([{ id: 3, snapshot_id: 7, title: "How does login work?", model: "openai/gpt-5.6-terra", created_at: "", updated_at: "2026-11-18T10:00:00Z" }]);
  api.retrieve.mockResolvedValue({ tokens: ["login"], results: [{ kind: "symbol", key: "sym:svc/auth.py#login", label: "login", path: "svc/auth.py", start_line: 4, end_line: 9, evidence_id: "ev_2", symbol_kind: "function", score: 10, signals: ["symbol_exact"] }] });
  api.symbols.mockResolvedValue([]);
});

describe("Repository explorer", () => {
  it("shows repository identity and a file tree that opens files", async () => {
    const user = userEvent.setup();
    const { nav } = renderWithNav(<Explorer />);
    expect(screen.getByText("shop")).toBeInTheDocument();
    expect(screen.getByText(/main @ 0123456789/)).toBeInTheDocument();
    // A single top-level source directory is expanded automatically.
    await user.click(await screen.findByRole("button", { name: /^svc$/ }));
    await user.click(await screen.findByRole("button", { name: "auth.py" }));
    expect(nav.openSource).toHaveBeenCalledWith({ path: "svc/auth.py" });
  });

  it("does not open files that were not analysed and says why", async () => {
    const user = userEvent.setup();
    const { nav } = renderWithNav(<Explorer />);
    await user.click(await screen.findByRole("button", { name: /^assets$/ }));
    const logo = await screen.findByRole("button", { name: /logo\.png/ });
    expect(logo).toHaveAttribute("aria-disabled", "true");
    expect(logo).toHaveAttribute("title", expect.stringContaining("not analysed"));
    await user.click(logo);
    expect(nav.openSource).not.toHaveBeenCalled();
  });

  it("searches the repository and opens the exact lines of a result", async () => {
    const user = userEvent.setup();
    const { nav } = renderWithNav(<Explorer />);
    await user.type(screen.getByRole("textbox", { name: "Search this repository" }), "login");
    const hit = await screen.findByRole("button", { name: /login[\s\S]*svc\/auth\.py:4/ });
    await user.click(hit);
    expect(nav.openSource).toHaveBeenCalledWith({ path: "svc/auth.py", start: 4, end: 9, sym: "sym:svc/auth.py#login" });
  });

  it("lists entry points and starts a trace; untraceable ones are disabled", async () => {
    const user = userEvent.setup();
    const { nav } = renderWithNav(<Explorer />);
    await user.click(screen.getByRole("tab", { name: "Entry points" }));
    const route = await screen.findByRole("button", { name: /POST \/login/ });
    await user.click(route);
    expect(nav.openFlow).toHaveBeenCalledWith("route:POST /login@svc/app.py:8");
    expect(screen.getByRole("button", { name: /python_main_guard|svc\/app\.py/ })).toBeDisabled();
  });

  it("lists saved investigations of this snapshot and reopens one in the assistant", async () => {
    const user = userEvent.setup();
    const { nav } = renderWithNav(<Explorer />, makeNav());
    await user.click(screen.getByRole("tab", { name: "Investigations" }));
    await user.click(await screen.findByRole("button", { name: /How does login work\?/ }));
    expect(nav.setParams).toHaveBeenCalledWith({ c: "3" });
    expect(nav.setAssistantOpen).toHaveBeenCalledWith(true);
    expect(api.conversations).toHaveBeenCalledWith(7);
  });

  it("has no detectable accessibility violations", async () => {
    const { container } = renderWithNav(<Explorer />);
    await screen.findByRole("tree", { name: "Repository files" });
    await waitFor(() => expect(within(container).getAllByRole("treeitem").length).toBeGreaterThan(0));
    expect(await axeViolations(container)).toEqual([]);
  });
});
