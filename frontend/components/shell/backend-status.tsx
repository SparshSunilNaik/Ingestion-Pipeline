"use client";

import { Copy, PlugZap, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui";

/** Errors that mean "the backend process cannot be reached", as opposed to an error it returned. */
export function isBackendDown(error: unknown): boolean {
  return error instanceof ApiError && ["backend_unavailable", "backend_timeout", "network_error"].includes(error.code);
}

const START_COMMAND = String.raw`powershell -ExecutionPolicy Bypass -File scripts\start-backend.ps1`;

/**
 * Full-page state shown when the frontend is up but the backend is not. It re-checks on its own,
 * so starting the backend is enough to recover; no reload is needed.
 */
export function BackendUnavailable({ error, onRetry, intervalMs = 4000 }: { error: unknown; onRetry: () => void; intervalMs?: number }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const t = setInterval(onRetry, intervalMs);
    return () => clearInterval(t);
  }, [onRetry, intervalMs]);
  const timeout = error instanceof ApiError && error.code === "backend_timeout";
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <section role="alert" aria-labelledby="backend-down-title" className="w-full max-w-[560px] rounded-xl border border-line bg-panel p-6">
        <div className="flex items-center gap-2.5 text-warn">
          <PlugZap className="h-5 w-5" aria-hidden />
          <h1 id="backend-down-title" className="text-[16px] font-semibold text-fg">{timeout ? "The backend is not responding" : "The backend is not running"}</h1>
        </div>
        <p className="mt-3 text-[13.5px] leading-relaxed text-fg-2">{message}</p>
        <p className="mt-4 text-[12.5px] text-fg-3">From the repository root, run:</p>
        <div className="mt-1.5 flex items-center gap-2 rounded-md border border-line bg-panel-2 px-3 py-2">
          <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[12.5px] whitespace-nowrap text-fg">{START_COMMAND}</code>
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(START_COMMAND).then(() => setCopied(true), () => undefined)}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[12px] text-fg-2 hover:bg-panel-3 hover:text-fg"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden /> {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="mt-5 flex items-center gap-3">
          <Button variant="primary" onClick={onRetry}>
            <RotateCw className="h-3.5 w-3.5" aria-hidden /> Check again
          </Button>
          <span className="text-[12px] text-fg-3" aria-live="polite">Checking automatically every {Math.round(intervalMs / 1000)} seconds. Your data is not affected.</span>
        </div>
      </section>
    </div>
  );
}
