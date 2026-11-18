"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Card, ErrorBox } from "@/components/ui";

export function SubmitView() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [checked, setChecked] = useState<{ url: string; valid: boolean; canonical_url: string | null; error: string | null } | null>(null);
  const check = checked && checked.url === url.trim() ? checked : null;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const value = url.trim();
    if (!value) return;
    const t = setTimeout(() => {
      api
        .validateUrl(value)
        .then((r) => setChecked({ url: value, ...r }))
        .catch(setError);
    }, 250);
    return () => clearTimeout(t);
  }, [url]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const { job } = await api.createJob(url);
      router.push(`/jobs/${job.id}`);
    } catch (e) {
      setError(e);
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Analyze a repository</h1>
        <p className="text-sm text-muted">
          Paste a public GitHub repository root URL. The repository is shallow-cloned into an isolated snapshot and analysed statically — its code is never executed.
        </p>
      </div>
      <Card>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (check?.valid) void submit();
          }}
        >
          <label htmlFor="url" className="block text-sm font-medium">
            Repository URL
          </label>
          <input
            id="url"
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repository"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm outline-none focus:border-accent"
            spellCheck={false}
            autoComplete="off"
          />
          <div className="min-h-5 text-sm" aria-live="polite">
            {check?.valid ? <span className="text-ok">Will analyse {check.canonical_url}</span> : null}
            {check && !check.valid ? <span className="text-bad">{check.error}</span> : null}
          </div>
          <ErrorBox error={error} />
          <Button type="submit" disabled={!check?.valid || submitting}>
            {submitting ? "Starting…" : "Start analysis"}
          </Button>
        </form>
      </Card>
      <Card title="What is accepted">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>
            <code>https://github.com/owner/repo</code> with an optional <code>.git</code> suffix.
          </li>
          <li>Rejected: other hosts, http/ssh/file schemes, credentials in the URL, ports, branch/file URLs, query strings.</li>
          <li>Re-submitting a repository whose HEAD commit was already analysed reuses the cached snapshot.</li>
        </ul>
      </Card>
    </div>
  );
}
