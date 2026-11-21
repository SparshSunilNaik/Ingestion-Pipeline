import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { BackendUnavailable, isBackendDown } from "@/components/shell/backend-status";
import { axeViolations } from "./helpers";

afterEach(() => vi.useRealTimers());

describe("Backend-unavailable state", () => {
  it("distinguishes an unreachable backend from an error the backend returned", () => {
    expect(isBackendDown(new ApiError(503, "backend_unavailable", "x"))).toBe(true);
    expect(isBackendDown(new ApiError(504, "backend_timeout", "x"))).toBe(true);
    expect(isBackendDown(new ApiError(0, "network_error", "x"))).toBe(true);
    expect(isBackendDown(new ApiError(500, "internal_error", "x"))).toBe(false);
    expect(isBackendDown(new ApiError(401, "unauthorized", "x"))).toBe(false);
  });

  it("explains what failed, shows the start command and retries on its own", async () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const { container } = render(<BackendUnavailable error={new ApiError(503, "backend_unavailable", "The backend is not reachable at http://127.0.0.1:8000.")} onRetry={onRetry} intervalMs={1000} />);
    expect(screen.getByRole("heading", { name: "The backend is not running" })).toBeInTheDocument();
    expect(screen.getByText(/not reachable at http:\/\/127\.0\.0\.1:8000/)).toBeInTheDocument();
    expect(screen.getByText(/start-backend\.ps1/)).toBeInTheDocument();
    expect(screen.queryByText(/Internal Server Error/)).toBeNull();
    act(() => vi.advanceTimersByTime(2100));
    expect(onRetry).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("retries immediately on request", async () => {
    const onRetry = vi.fn();
    render(<BackendUnavailable error={new ApiError(504, "backend_timeout", "slow")} onRetry={onRetry} />);
    expect(screen.getByRole("heading", { name: "The backend is not responding" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Check again/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
