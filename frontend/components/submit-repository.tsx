"use client";

import { ArrowRight, GitBranch } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, ErrorState, cn } from "@/components/ui";

/** Repository submission with live URL validation; navigates to the job progress page. */
export function SubmitRepository({ compact }: { compact?: boolean }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [checked, setChecked] = useState<{ url: string; valid: boolean; canonical_url: string | null; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const value = url.trim();
  const check = checked && checked.url === value ? checked : null;

  useEffect(() => {
    if (!value) return;
    const t = setTimeout(() => {
      api
        .validateUrl(value)
        .then((r) => setChecked({ url: value, ...r }))
        .catch(setError);
    }, 220);
    return () => clearTimeout(t);
  }, [value]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!check?.valid) return;
    setBusy(true);
    setError(null);
    try {
      const { job } = await api.createJob(value);
      router.push(`/jobs/${job.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2" aria-label="Analyze a repository">
      <div className={cn("flex gap-2", compact ? "" : "items-stretch")}>
        <div className="relative min-w-0 flex-1">
          <GitBranch className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
          <input
            aria-label="GitHub repository URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repository"
            spellCheck={false}
            autoComplete="off"
            className={cn(
              "h-9 w-full rounded-md border bg-panel-2 pr-3 pl-8 font-mono text-[12.5px] outline-none placeholder:text-fg-3 focus:border-accent",
              check && !check.valid ? "border-bad/60" : "border-line",
            )}
          />
        </div>
        <Button type="submit" variant="primary" className="h-9" disabled={!check?.valid || busy}>
          {busy ? "Starting…" : "Analyze"} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
      <div className="min-h-[18px] text-[12px]" aria-live="polite">
        {check?.valid && <span className="text-ok">Ready to analyse {check.canonical_url} — shallow clone, static analysis only, no code execution.</span>}
        {check && !check.valid && <span className="text-bad">{check.error}</span>}
        {!check && !compact && <span className="text-fg-3">Public github.com repository root. A commit that was already analysed is reused from cache.</span>}
      </div>
      <ErrorState error={error} compact />
    </form>
  );
}
