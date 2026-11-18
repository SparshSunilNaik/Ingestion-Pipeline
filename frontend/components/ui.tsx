"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { Basis, JobStatus } from "@/lib/api";

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-lg border border-border bg-surface", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

type Tone = "neutral" | "accent" | "ok" | "warn" | "bad";
const toneClass: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted border-border",
  accent: "bg-accent-soft text-accent border-transparent",
  ok: "bg-ok-soft text-ok border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  bad: "bg-bad-soft text-bad border-transparent",
};

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap", toneClass[tone])}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: JobStatus | string }) {
  const tone: Tone = status === "succeeded" || status === "ready" ? "ok" : status === "failed" ? "bad" : status === "running" || status === "analyzing" ? "accent" : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}

const BASIS: Record<Basis, { label: string; tone: Tone; help: string }> = {
  source_evidence: { label: "source", tone: "ok", help: "Cites implementation source or test code" },
  configuration_evidence: { label: "config", tone: "accent", help: "Cites manifests or configuration only" },
  documentation_claim: { label: "docs claim", tone: "warn", help: "Supported by documentation only; not verified against code" },
  inventory_measured: { label: "measured", tone: "neutral", help: "Deterministic inventory statistic" },
  heuristic: { label: "heuristic", tone: "neutral", help: "Heuristic judgement, not a proven fact" },
  unknown: { label: "unknown", tone: "neutral", help: "Could not be determined" },
  unsupported: { label: "unsupported", tone: "bad", help: "Model statement without valid evidence" },
};

export function BasisBadge({ basis }: { basis: Basis }) {
  const b = BASIS[basis] ?? { label: basis, tone: "neutral" as Tone, help: "" };
  return (
    <Badge tone={b.tone} title={b.help}>
      {b.label}
    </Badge>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  type = "button",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "ghost";
  type?: "button" | "submit";
  title?: string;
}) {
  const styles = {
    primary: "bg-accent text-white hover:opacity-90",
    secondary: "border border-border bg-surface hover:bg-surface-2",
    ghost: "hover:bg-surface-2 text-muted",
  }[variant];
  return (
    <button type={type} title={title} onClick={onClick} disabled={disabled} className={cn("inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50", styles)}>
      {children}
    </button>
  );
}

export function ProgressBar({ value, tone = "accent" }: { value: number; tone?: "accent" | "ok" | "bad" }) {
  const color = { accent: "bg-accent", ok: "bg-ok", bad: "bg-bad" }[tone];
  return (
    <div className="h-2 w-full overflow-hidden rounded bg-surface-2" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn("h-full transition-all", color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <div className="rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-sm text-bad">{msg}</div>;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted" role="status">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-accent" />
      {label}…
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div title={hint}>
      <div className="text-xs text-muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: { id: T; label: string }[]; active: T; onChange: (t: T) => void }) {
  return (
    <div className="flex gap-1 border-b border-border" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={cn("-mb-px border-b-2 px-3 py-2 text-sm", active === t.id ? "border-accent font-medium text-text" : "border-transparent text-muted hover:text-text")}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function ShortSha({ sha }: { sha: string }) {
  return (
    <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs" title={sha}>
      {sha.slice(0, 12)}
    </code>
  );
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-accent hover:underline">
      {children}
    </Link>
  );
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}
