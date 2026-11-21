"use client";

import { KeyRound } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { BackendUnavailable, isBackendDown } from "@/components/shell/backend-status";
import { Button, ErrorState } from "@/components/ui";

export function LoginView() {
  const router = useRouter();
  const search = useSearchParams();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const health = useAsync(() => api.health(), []);
  const next = search.get("next");
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(token.trim());
      router.replace(safeNext);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  if (health.error && isBackendDown(health.error)) return <div className="h-full bg-bg"><BackendUnavailable error={health.error} onRetry={health.reload} /></div>;
  return (
    <div className="atlas-grid flex h-full items-center justify-center bg-bg p-6">
      <form onSubmit={submit} className="atlas-in w-[420px] rounded-xl border border-line bg-panel p-7 shadow-[var(--shadow)]">
        <div className="mb-6">
          <div className="atlas-label flex items-center gap-2"><span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" aria-hidden /> code atlas</div>
          <h1 className="atlas-display mt-2 text-[34px] text-fg">Sign in to your atlas</h1>
          <p className="mt-1 text-[12.5px] text-fg-3">Ingestion-Pipeline · local repository intelligence</p>
        </div>
        <label htmlFor="token" className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-fg-2">
          <KeyRound className="h-3.5 w-3.5" aria-hidden /> API token
        </label>
        <input
          id="token"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="h-9 w-full rounded-md border border-line bg-panel-2 px-3 font-mono text-[13px] outline-none focus:border-accent"
        />
        <p className="mt-2 text-[11.5px] leading-relaxed text-fg-3">
          The backend generated this token on first start in <code className="font-mono text-fg-2">backend/data/api-token</code>, readable only by your Windows user. It is exchanged
          for an HttpOnly session cookie and never stored by this page.
        </p>
        <div className="mt-3">
          <ErrorState error={error} compact />
        </div>
        <Button type="submit" variant="primary" className="mt-4 w-full" disabled={!token.trim() || busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
