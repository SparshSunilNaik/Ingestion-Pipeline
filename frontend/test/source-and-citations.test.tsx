import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Source } from "@/lib/api";
import { ClaimList } from "@/components/workspace/claims";
import { EvidenceChip } from "@/components/workspace/nav";
import { SourceView, splitHighlighted } from "@/components/workspace/source-view";
import { axeViolations, renderWithNav } from "./helpers";

const api = vi.hoisted(() => ({ evidence: vi.fn() }));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api }));

const SOURCE: Source = {
  path: "svc/auth.py",
  start_line: 1,
  end_line: 6,
  total_lines: 6,
  language: "python",
  lines: ["def login(name):", "    account = create(name)", "    return token(account)", "", "def token(a):", "    return a"],
};

describe("Source viewer", () => {
  it("renders every line with its number and highlights the requested range", () => {
    const { container } = render(<SourceView source={SOURCE} highlight={[2, 3]} />);
    const rows = container.querySelectorAll("tr[data-line]");
    expect(rows).toHaveLength(6);
    expect([...container.querySelectorAll("tr[data-highlighted]")].map((r) => r.getAttribute("data-line"))).toEqual(["2", "3"]);
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("applies syntax highlighting without breaking lines", () => {
    const { container } = render(<SourceView source={SOURCE} />);
    expect(container.querySelector(".hljs-keyword")).not.toBeNull();
    expect(container.querySelector('tr[data-line="1"]')?.textContent).toContain("def login(name):");
  });

  it("marks find-in-file matches and reports line clicks", async () => {
    const onLineClick = vi.fn();
    const { container } = render(<SourceView source={SOURCE} findLines={new Set([1, 5])} currentFind={5} onLineClick={onLineClick} />);
    expect([...container.querySelectorAll("tr[data-find]")].map((r) => r.getAttribute("data-line"))).toEqual(["1", "5"]);
    await userEvent.click(screen.getByText("3"));
    expect(onLineClick).toHaveBeenCalledWith(3);
  });

  it("splits highlighted HTML that spans lines into balanced per-line HTML", () => {
    const lines = splitHighlighted('<span class="a">x\ny</span>z');
    expect(lines).toEqual(['<span class="a">x</span>', '<span class="a">y</span>z']);
  });

  it("escapes source text that is not highlighted", () => {
    const { container } = render(<SourceView source={{ ...SOURCE, language: null, path: "notes.txt", lines: ["<script>alert(1)</script>"] }} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
});

describe("Citation navigation", () => {
  beforeEach(() => {
    api.evidence.mockImplementation(async (id: string) => {
      if (id === "ev_missing") throw new Error("not found");
      return { id, path: "svc/auth.py", start_line: 2, end_line: 3, category: "call", subject: null, source_kind: "source", extraction_method: "python_ast", verification_status: "verified", verified_now: true, verification_reason: null, commit_sha: "0123", excerpt: null };
    });
  });

  it("resolves an evidence ID to its location and opens exactly those lines", async () => {
    const user = userEvent.setup();
    const { nav } = renderWithNav(<EvidenceChip id="ev_abc" />);
    const chip = await screen.findByRole("button", { name: "svc/auth.py:2-3, open svc/auth.py lines 2–3" });
    expect(chip).toHaveTextContent("svc/auth.py:2-3");
    await user.click(chip);
    expect(nav.openSource).toHaveBeenCalledWith({ path: "svc/auth.py", start: 2, end: 3 });
  });

  it("disables a citation whose evidence cannot be loaded", async () => {
    renderWithNav(<EvidenceChip id="ev_missing" />);
    await waitFor(() => expect(screen.getByRole("button")).toBeDisabled());
    expect(screen.getByRole("button")).toHaveTextContent("unavailable");
  });

  it("labels claims by their evidence basis and strikes through unsupported ones", async () => {
    const { container } = renderWithNav(
      <ClaimList
        claims={[
          { statement: "login issues a token", basis: "source_evidence", evidence_ids: ["ev_abc"], note: null },
          { statement: "Uses Redis", basis: "unsupported", evidence_ids: [], note: null },
        ]}
      />,
    );
    expect(screen.getByText("source")).toBeInTheDocument();
    expect(screen.getByText("Uses Redis")).toHaveClass("line-through");
    await screen.findByRole("button", { name: /open svc\/auth\.py/ });
    expect(await axeViolations(container)).toEqual([]);
  });
});
