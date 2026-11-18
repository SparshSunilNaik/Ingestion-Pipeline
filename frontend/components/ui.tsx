"use client";

import { CircleExclamationPoint, LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Basis, JobStatus, Resolution } from "@/lib/api";

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- surfaces
export function Panel({ title, icon, actions, children, className, bodyClassName, id }: {
  title?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("flex min-h-0 flex-col rounded-lg border border-line bg-panel", className)}>
      {(title || actions) && (
        <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
          <h2 className="flex items-center gap-2 text-[12px] font-semibold tracking-wide text-fg-2 uppercase">
            {icon}
            {title}
          </h2>
          <div className="flex items-center gap-1.5">{actions}</div>
        </header>
      )}
      <div className={cn("min-h-0 flex-1 p-3", bodyClassName)}>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------- buttons
type Variant = "primary" | "secondary" | "ghost" | "danger";
const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:brightness-110 border-transparent",
  secondary: "bg-panel-2 text-fg border-line hover:bg-panel-3 hover:border-line-strong",
  ghost: "bg-transparent text-fg-2 border-transparent hover:bg-panel-3 hover:text-fg",
  danger: "bg-bad-soft text-bad border-transparent hover:brightness-110",
};

export function Button({ variant = "secondary", size = "md", className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        size === "sm" ? "h-7 px-2 text-[12px]" : "h-8 px-3 text-[13px]",
        variants[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function IconButton({ label, children, className, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-panel-3 hover:text-fg disabled:opacity-40",
        active && "bg-accent-soft text-accent",
        className,
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- badges & status
type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info";
const tones: Record<Tone, string> = {
  neutral: "bg-panel-3 text-fg-2",
  accent: "bg-accent-soft text-accent",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  info: "bg-info-soft text-info",
};

export function Badge({ tone = "neutral", children, title, className }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cn("inline-flex h-[18px] shrink-0 items-center gap-1 rounded px-1.5 text-[11px] leading-none font-medium whitespace-nowrap", tones[tone], className)}>
      {children}
    </span>
  );
}

export function StatusDot({ tone = "neutral", pulse }: { tone?: Tone; pulse?: boolean }) {
  const color = { neutral: "bg-fg-3", accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", info: "bg-info" }[tone];
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", color, pulse && "animate-pulse")} aria-hidden />;
}

export function jobTone(status: JobStatus | string): Tone {
  return status === "succeeded" || status === "ready" ? "ok" : status === "failed" ? "bad" : status === "running" || status === "analyzing" ? "accent" : status === "cancelled" ? "warn" : "neutral";
}

export function StatusBadge({ status }: { status: JobStatus | string }) {
  return (
    <Badge tone={jobTone(status)}>
      <StatusDot tone={jobTone(status)} pulse={status === "running"} />
      {status}
    </Badge>
  );
}

const BASIS: Record<Basis, { label: string; tone: Tone; help: string }> = {
  source_evidence: { label: "source", tone: "ok", help: "Cites implementation source or test code (verified location)" },
  configuration_evidence: { label: "config", tone: "info", help: "Cites manifests or configuration only" },
  documentation_claim: { label: "docs claim", tone: "warn", help: "Supported only by documentation; the code was not checked" },
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

export const RESOLUTION_TONE: Record<Resolution | string, Tone> = { resolved: "ok", ambiguous: "warn", external: "info", unresolved: "bad" };

export function ResolutionBadge({ resolution, via }: { resolution: Resolution | string; via?: string | null }) {
  return (
    <Badge tone={RESOLUTION_TONE[resolution] ?? "neutral"} title={via ? `${resolution} via ${via.replaceAll("_", " ")}` : resolution}>
      {resolution}
    </Badge>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line-strong bg-panel-2 px-1 font-mono text-[10.5px] text-fg-2">{children}</kbd>;
}

// ---------------------------------------------------------------- states
export function Spinner({ label = "Loading", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 text-[12.5px] text-fg-3", className)} role="status">
      <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
      {label}…
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton h-3", className)} aria-hidden />;
}

export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={i % 3 === 2 ? "w-2/3" : "w-full"} />
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon && <div className="text-fg-3">{icon}</div>}
      <div className="text-[13px] font-medium text-fg">{title}</div>
      {children && <div className="max-w-md text-[12.5px] text-fg-3">{children}</div>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className={cn("flex items-start gap-2 rounded-md border border-bad/30 bg-bad-soft text-[12.5px] text-bad", compact ? "px-2 py-1.5" : "px-3 py-2.5")}>
      <CircleExclamationPoint className="mt-px h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 break-words">{msg}</div>
      {onRetry && (
        <button className="shrink-0 font-medium underline-offset-2 hover:underline" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Metric({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: Tone }) {
  return (
    <div title={hint} className="min-w-0">
      <div className="truncate text-[11px] tracking-wide text-fg-3 uppercase">{label}</div>
      <div className={cn("mt-0.5 font-mono text-[17px] font-semibold tabular-nums", tone === "warn" && "text-warn", tone === "bad" && "text-bad", tone === "ok" && "text-ok")}>{value}</div>
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange, label }: { options: { id: T; label: ReactNode; title?: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-7 items-center rounded-md border border-line bg-panel-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          title={o.title}
          onClick={() => onChange(o.id)}
          className={cn("h-full rounded px-2 text-[12px] font-medium transition-colors", value === o.id ? "bg-panel-3 text-fg shadow-sm" : "text-fg-3 hover:text-fg")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- formatting
export function formatBytes(n: number | null | undefined) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function timeAgo(iso: string | null | undefined, now: number) {
  if (!iso) return "—";
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function ShortSha({ sha, className }: { sha: string; className?: string }) {
  return (
    <code className={cn("rounded bg-panel-3 px-1.5 py-px font-mono text-[11.5px] text-fg-2", className)} title={sha}>
      {sha.slice(0, 10)}
    </code>
  );
}

export const LANG_COLORS: Record<string, string> = {
  python: "#3b82c4",
  typescript: "#3178c6",
  javascript: "#d4b830",
  go: "#00add8",
  java: "#e76f00",
  shell: "#89e051",
  rust: "#dea584",
  html: "#e34c26",
  css: "#563d7c",
};

export function LanguageBar({ data, height = 6 }: { data: Record<string, number>; height?: number }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((a, [, v]) => a + v, 0) || 1;
  if (!entries.length) return <span className="text-[12px] text-fg-3">No source languages detected</span>;
  return (
    <div className="space-y-1.5">
      <div className="flex overflow-hidden rounded-full bg-panel-3" style={{ height }}>
        {entries.map(([k, v]) => (
          <div key={k} title={`${k} ${((v / total) * 100).toFixed(1)}%`} style={{ width: `${(v / total) * 100}%`, background: LANG_COLORS[k] ?? "var(--fg-3)" }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-fg-2">
        {entries.slice(0, 6).map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: LANG_COLORS[k] ?? "var(--fg-3)" }} />
            {k} <span className="text-fg-3">{((v / total) * 100).toFixed(0)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
