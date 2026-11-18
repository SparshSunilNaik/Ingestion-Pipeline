"use client";

import { GitBranch, KeyRound } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button, ErrorState } from "@/components/ui";

export function LoginView() {
  const router = useRouter();
  const search = useSearchParams();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
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

  return (
    <div className="flex h-full items-center justify-center bg-bg p-6">
      <form onSubmit={submit} className="w-[400px] rounded-lg border border-line bg-panel p-6 shadow-[var(--shadow)]">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-accent-soft text-accent">
            <GitBranch className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <h1 className="text-[15px] font-semibold">Ingestion-Pipeline</h1>
            <p className="text-[12px] text-fg-3">Local repository intelligence workbench</p>
          </div>
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
