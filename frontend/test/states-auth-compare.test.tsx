import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Job } from "@/lib/api";
import { JobView } from "@/app/jobs/[id]/job-view";
import { LoginView } from "@/app/login/login-view";
import { Compare } from "@/components/workspace/compare";
import { ErrorState } from "@/components/ui";
import { SNAPSHOT, axeViolations, makeNav, renderWithNav } from "./helpers";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }));
const search = vi.hoisted(() => ({ value: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => search.value,
  usePathname: () => "/",
  useParams: () => ({ id: "42" }),
}));

const api = vi.hoisted(() => ({ job: vi.fn(), cancelJob: vi.fn(), createJob: vi.fn(), login: vi.fn(), repositories: vi.fn(), compare: vi.fn(), refreshRepository: vi.fn(), evidence: vi.fn() }));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api }));

const job = (j: Partial<Job>): Job => ({
  id: 42, kind: "ingest", repository_id: 1, snapshot_id: null, requested_url: "https://github.com/acme/shop", status: "running", stage: "cloning", progress: 15,
  message: "Shallow clone (depth 50)", error_code: null, error_message: null, attempts: 1, reused_cache: false, created_at: "2026-11-18T10:00:00Z",
  started_at: "2026-11-18T10:00:00Z", finished_at: null, params: {}, ...j,
});

beforeEach(() => {
  router.push.mockReset();
  router.replace.mockReset();
  search.value = new URLSearchParams();
});

describe("Analysis progress (loading, error and recovery states)", () => {
  it("shows real stages with the current one and its live message, and can cancel", async () => {
    const user = userEvent.setup();
    api.job.mockResolvedValue(job({}));
    api.cancelJob.mockResolvedValue(job({ status: "cancelled" }));
    const { container } = render(<JobView />);
    const current = await screen.findByText("Acquiring the repository");
    expect(current.closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("Shallow clone (depth 50)")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull(); // no invented percentage
    await user.click(screen.getByRole("button", { name: /Cancel analysis/ }));
    expect(api.cancelJob).toHaveBeenCalledWith(42);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("explains a failure at the stage where it happened and retries the same repository", async () => {
    const user = userEvent.setup();
    api.job.mockResolvedValue(job({ status: "failed", stage: "resolving", error_code: "acquisition_failed", error_message: "git ls-remote failed" }));
    api.createJob.mockResolvedValue({ job: job({ id: 43, status: "queued", stage: "queued" }), created: true });
    render(<JobView />);
    expect(await screen.findByText("Analysis failed")).toBeInTheDocument();
    expect(screen.getByText(/GitHub could not be reached/)).toBeInTheDocument();
    expect(screen.getByText("Connecting to GitHub").closest("li")?.querySelector(".text-bad")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: /Try again/ }));
    expect(api.createJob).toHaveBeenCalledWith("https://github.com/acme/shop");
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/jobs/43"));
  });

  it("opens the workspace when the analysis succeeds", async () => {
    api.job.mockResolvedValue(job({ status: "succeeded", stage: "complete", snapshot_id: 7 }));
    render(<JobView />);
    expect(await screen.findByText(/Analysis complete/)).toBeInTheDocument();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/snapshots/7"), { timeout: 2000 });
  });

  it("renders errors as alerts with a retry action", async () => {
    const onRetry = vi.fn();
    render(<ErrorState error={new ApiError(0, "network_error", "Cannot reach the backend.")} onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Cannot reach the backend.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("Authentication", () => {
  it("rejects a wrong token with a visible error and keeps the user on the page", async () => {
    const user = userEvent.setup();
    api.login.mockRejectedValue(new ApiError(401, "unauthorized", "Invalid token"));
    render(<LoginView />);
    const submit = screen.getByRole("button", { name: "Sign in" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/API token/), "wrong");
    await user.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid token");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("signs in and returns to the requested page, refusing off-site redirects", async () => {
    const user = userEvent.setup();
    api.login.mockResolvedValue({ authenticated: true });
    search.value = new URLSearchParams("next=//evil.example/x");
    const { container } = render(<LoginView />);
    await user.type(screen.getByLabelText(/API token/), "right-token");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(api.login).toHaveBeenCalledWith("right-token");
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("Snapshot comparison", () => {
  const repo = (snaps: { id: number; sha: string }[]) => [
    { id: 1, owner: "acme", name: "shop", snapshots: snaps.map((s) => ({ id: s.id, commit_sha: s.sha, status: "ready", default_branch: "main", acquired_at: "2026-11-18T10:00:00Z", analyzer_version: "0.3.0" })) },
  ];

  it("offers a refresh when only one snapshot exists", async () => {
    const user = userEvent.setup();
    api.repositories.mockResolvedValue(repo([{ id: 7, sha: SNAPSHOT.commit_sha }]));
    api.refreshRepository.mockResolvedValue({ job: { id: 50 }, created: true });
    renderWithNav(<Compare snapshot={SNAPSHOT} />);
    expect(await screen.findByText("Only one analysed snapshot")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Refresh analysis/ }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/jobs/50"));
  });

  it("shows real differences between two snapshots and opens changed code", async () => {
    const user = userEvent.setup();
    api.repositories.mockResolvedValue(repo([{ id: 7, sha: SNAPSHOT.commit_sha }, { id: 6, sha: "fedcba9876" }]));
    api.compare.mockResolvedValue({
      base: { id: 6, commit_sha: "fedcba9876", analyzer_version: "0.3.0" },
      head: { id: 7, commit_sha: SNAPSHOT.commit_sha, analyzer_version: "0.3.0" },
      files: { added: ["svc/audit.py"], removed: [], modified: [], counts: { added: 1, removed: 0, modified: 0 } },
      symbols: { added: [{ path: "svc/audit.py", qualified_name: "record", kind: "function", start_line: 1, end_line: 3 }], removed: [], signature_changed: [], counts: { added: 1, removed: 0, signature_changed: 0 } },
      dependencies: { added: [], removed: [], changed: [] },
      routes: { added: [], removed: [] },
      graph: { edges_added: [], edges_removed: [], counts: { added: 0, removed: 0 } },
      potential_impact: { unchanged_dependents_of_changed_code: [], count: 0, note: "" },
      limitations: [],
    });
    const { nav } = renderWithNav(<Compare snapshot={SNAPSHOT} />, makeNav());
    await waitFor(() => expect(api.compare).toHaveBeenCalledWith(6, 7));
    await user.click(await screen.findByRole("button", { name: /svc\/audit\.py/ }));
    expect(nav.openSource).toHaveBeenCalledWith({ path: "svc/audit.py" });
  });
});
