"use client";

import {
  Bot,
  Boxes,
  Clock,
  GitBranch,
  Keyboard,
  LayoutDashboard,
  Library,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sun,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { api, setUnauthorizedHandler } from "@/lib/api";
import { useAsync, useHotkey, usePref } from "@/lib/hooks";
import { BackendUnavailable, isBackendDown } from "@/components/shell/backend-status";
import { CommandPalette } from "@/components/shell/command-palette";
import { Toaster } from "@/components/shell/toaster";
import { Badge, IconButton, Kbd, ShortSha, StatusDot, cn, jobTone, ErrorState } from "@/components/ui";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, match: (p: string) => p === "/" },
  { href: "/repositories", label: "Repositories", icon: Library, match: (p: string) => p.startsWith("/repositories") },
  { href: "/jobs", label: "Recent analyses", icon: Clock, match: (p: string) => p.startsWith("/jobs") },
  { href: "/workspace", label: "Intelligence workspace", icon: Boxes, match: (p: string) => p.startsWith("/snapshots") || p === "/workspace" },
  { href: "/settings", label: "Settings", icon: Settings, match: (p: string) => p.startsWith("/settings") },
];

export const SHORTCUTS: [string, string][] = [
  ["Ctrl K", "Command palette: jump to files, symbols, repositories"],
  ["/", "Search this repository (workspace explorer)"],
  ["Ctrl B", "Toggle the repository explorer (sidebar outside the workspace)"],
  ["Ctrl I", "Toggle the investigation assistant"],
  ["Ctrl .", "Focus mode: hide explorer and assistant"],
  ["Alt ↑ / ↓", "Previous / next definition in a file"],
  ["Ctrl F", "Find in the open file"],
  ["Alt 1", "Overview"],
  ["Alt 2", "Last open file"],
  ["Alt 3", "Architecture graph"],
  ["Alt 4", "Open the assistant"],
  ["Alt 5", "Technical report"],
  ["Alt 6", "Compare snapshots"],
  ["Alt W", "Close the current tab"],
  ["?", "Show keyboard shortcuts"],
  ["Esc", "Close dialogs"],
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = usePref("ip.sidebar", "open");
  const [theme, setTheme] = usePref("ip.theme", "dark");
  const [lastSnapshot] = usePref("ip.lastSnapshot", "");
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const isLogin = pathname.startsWith("/login");
  const auth = useAsync(() => (isLogin ? Promise.resolve(null) : api.authStatus()), [isLogin]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
  }, [theme]);

  const toLogin = useCallback(() => {
    if (!window.location.pathname.startsWith("/login")) {
      router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }
  }, [router]);
  useEffect(() => {
    setUnauthorizedHandler(toLogin);
    return () => setUnauthorizedHandler(null);
  }, [toLogin]);
  const unauthenticated = auth.data && !auth.data.authenticated;
  useEffect(() => {
    if (unauthenticated) toLogin();
  }, [unauthenticated, toLogin]);

  useHotkey("mod+k", () => setPalette((v) => !v), { allowInInputs: true });
  const inWorkspace = pathname.startsWith("/snapshots/");
  // Inside the workspace Ctrl+B toggles the repository explorer instead (handled there).
  useHotkey("mod+b", () => !window.location.pathname.startsWith("/snapshots/") && setCollapsed(collapsed === "open" ? "closed" : "open"), { allowInInputs: true });
  useHotkey("?", () => setHelp((v) => !v));
  useHotkey("escape", () => {
    setPalette(false);
    setHelp(false);
  }, { allowInInputs: true });

  if (isLogin) return <>{children}</>;
  // The workspace has its own explorer; the app navigation shrinks to an icon rail there.
  const open = collapsed === "open" && !inWorkspace;
  const snapshotMatch = pathname.match(/^\/snapshots\/(\d+)/);
  const activeSnapshot = snapshotMatch ? Number(snapshotMatch[1]) : lastSnapshot ? Number(lastSnapshot) : null;

  return (
    <div className="flex h-full">
      <aside className={cn("flex shrink-0 flex-col border-r border-line bg-panel transition-[width] duration-150", open ? "w-[220px]" : "w-[52px]")} aria-label="Primary">
        <div className="flex h-11 items-center gap-2 border-b border-line px-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center" aria-hidden>
            <AtlasMark />
          </span>
          {open && (
            <span className="truncate font-mono text-[11.5px] font-semibold tracking-[0.18em] uppercase">
              Code <span className="text-accent">Atlas</span>
            </span>
          )}
        </div>
        <nav className="flex flex-col gap-0.5 p-2">
          {NAV.map((n) => {
            const active = n.match(pathname);
            const href = n.href === "/workspace" && activeSnapshot ? `/snapshots/${activeSnapshot}` : n.href;
            return (
              <Link
                key={n.href}
                href={href}
                title={open ? undefined : n.label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors",
                  active ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-panel-3 hover:text-fg",
                )}
              >
                <n.icon className="h-4 w-4 shrink-0" aria-hidden />
                {open && <span className="truncate">{n.label}</span>}
              </Link>
            );
          })}
        </nav>
        {open && activeSnapshot ? <ActiveRepository snapshotId={activeSnapshot} /> : null}
        <div className="mt-auto flex flex-col gap-1 border-t border-line p-2">
          <div className={cn("flex items-center", open ? "justify-between" : "flex-col gap-1")}>
            {!inWorkspace && (
              <IconButton label={open ? "Collapse sidebar (Ctrl+B)" : "Expand sidebar (Ctrl+B)"} onClick={() => setCollapsed(open ? "closed" : "open")}>
                {open ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
              </IconButton>
            )}
            <IconButton label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"} onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
              {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </IconButton>
            <IconButton label="Keyboard shortcuts (?)" onClick={() => setHelp(true)}>
              <Keyboard className="h-4 w-4" />
            </IconButton>
            <IconButton
              label="Sign out"
              onClick={() => api.logout().finally(() => router.replace("/login"))}
            >
              <LogOut className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar snapshotId={snapshotMatch ? Number(snapshotMatch[1]) : null} onSearch={() => setPalette(true)} />
        <main className="min-h-0 flex-1 overflow-auto">
          {auth.error ? (
            isBackendDown(auth.error) ? (
              <BackendUnavailable error={auth.error} onRetry={auth.reload} />
            ) : (
              <div className="p-6"><ErrorState error={auth.error} onRetry={auth.reload} /></div>
            )
          ) : auth.data?.authenticated === false ? null : (
            children
          )}
        </main>
      </div>
      {palette && <CommandPalette snapshotId={activeSnapshot} onClose={() => setPalette(false)} />}
      <Toaster />
      {help && <ShortcutsDialog onClose={() => setHelp(false)} />}
    </div>
  );
}

function ActiveRepository({ snapshotId }: { snapshotId: number }) {
  const snap = useAsync(() => api.snapshot(snapshotId).catch(() => null), [snapshotId]);
  const s = snap.data;
  if (!s) return null;
  return (
    <div className="mx-2 mt-2 rounded-md border border-line bg-panel-2 p-2.5">
      <div className="text-[10.5px] tracking-wider text-fg-3 uppercase">Active repository</div>
      <Link href={`/snapshots/${s.id}`} className="mt-1 block truncate text-[12.5px] font-medium hover:text-accent">
        {s.repository.owner}/{s.repository.name}
      </Link>
      <div className="mt-1 flex items-center gap-1.5">
        <ShortSha sha={s.commit_sha} />
        <Badge tone={jobTone(s.status)}>{s.status}</Badge>
      </div>
    </div>
  );
}

function TopBar({ snapshotId, onSearch }: { snapshotId: number | null; onSearch: () => void }) {
  const router = useRouter();
  const snap = useAsync(() => (snapshotId ? api.snapshot(snapshotId) : Promise.resolve(null)), [snapshotId]);
  const repos = useAsync(() => (snapshotId ? api.repositories().catch(() => []) : Promise.resolve([])), [snapshotId]);
  const siblings = (repos.data ?? []).find((r) => r.id === snap.data?.repository.id)?.snapshots.filter((x) => x.status === "ready") ?? [];
  const agent = useAsync(() => api.agentStatus().catch(() => null), [], 60_000);
  const s = snap.data;
  const a = agent.data;
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {s ? (
          <>
            <Link href={`/snapshots/${s.id}`} className="truncate text-[13.5px] font-semibold hover:text-accent">
              {s.repository.owner}/<span className="text-fg">{s.repository.name}</span>
            </Link>
            <span className="inline-flex items-center gap-1 text-[12px] text-fg-3">
              <GitBranch className="h-3.5 w-3.5" aria-hidden />
              {s.default_branch ?? "unknown"}
            </span>
            {siblings.length > 1 ? (
              <select
                value={s.id}
                onChange={(e) => router.push(`/snapshots/${e.target.value}`)}
                aria-label="Switch snapshot"
                title="Each snapshot is one analysed commit (and analyzer version)"
                className="h-6 max-w-[260px] rounded border border-line bg-panel-2 px-1 font-mono text-[11.5px] text-fg-2"
              >
                {siblings.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.commit_sha.slice(0, 10)} · analyzer {x.analyzer_version}
                  </option>
                ))}
              </select>
            ) : (
              <ShortSha sha={s.commit_sha} />
            )}
            {s.status !== "ready" && <Badge tone={jobTone(s.status)}>{s.status}</Badge>}
            {s.coverage.is_partial && <Badge tone="warn" title="Some eligible files were skipped by the analysis limits">partial coverage</Badge>}
            {siblings.length <= 1 && <span className="hidden text-[11.5px] text-fg-3 xl:inline">analyzer {s.analyzer_version}</span>}
          </>
        ) : (
          <span className="flex items-center gap-2 text-[13px] text-fg-2">
            <span className="atlas-label">code atlas</span>
            <span className="text-fg-3">·</span>
            <span className="text-[12.5px] text-fg-3">explore software like a living system</span>
          </span>
        )}
      </div>
      <button
        onClick={onSearch}
        className="hidden h-7 w-64 shrink-0 items-center gap-2 rounded-md border border-line bg-panel-2 px-2 text-[12px] whitespace-nowrap text-fg-3 hover:border-line-strong md:flex"
        title="Command palette (Ctrl K)"
      >
        <Search className="h-3.5 w-3.5" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-left">Search symbols, files, repos…</span>
        <Kbd>Ctrl K</Kbd>
      </button>
      <Link href="/settings" className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-fg-2 hover:bg-panel-3" title={a?.error ?? undefined}>
        <Bot className="h-3.5 w-3.5" aria-hidden />
        <StatusDot tone={!a ? "neutral" : a.agent_ready ? "ok" : "warn"} />
        <span className="hidden max-w-[180px] truncate font-mono text-[11.5px] sm:inline">{a ? a.selected_model : "agent"}</span>
      </Link>
    </header>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]" onClick={onClose}>
      <div role="dialog" aria-label="Keyboard shortcuts" aria-modal className="atlas-in w-[420px] rounded-xl border border-line bg-panel p-4 shadow-[var(--shadow)]" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-[13px] font-semibold">Keyboard shortcuts</h2>
        <dl className="space-y-2 text-[12.5px]">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="flex items-center justify-between gap-4">
              <dt className="text-fg-2">{d}</dt>
              <dd className="flex gap-1">
                {k.split(" ").map((p) => (
                  <Kbd key={p}>{p}</Kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** The Code Atlas mark: a node in focus with its relationships — the product's one idea, drawn small. */
function AtlasMark() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22">
      <line x1="12" y1="12" x2="4" y2="6" stroke="var(--support)" strokeWidth="1.3" />
      <line x1="12" y1="12" x2="20" y2="7" stroke="var(--support)" strokeWidth="1.3" />
      <line x1="12" y1="12" x2="15" y2="20" stroke="var(--accent)" strokeWidth="1.6" />
      <circle cx="4" cy="6" r="2" fill="var(--bg)" stroke="var(--support)" strokeWidth="1.3" />
      <circle cx="20" cy="7" r="2" fill="var(--bg)" stroke="var(--support)" strokeWidth="1.3" />
      <circle cx="15" cy="20" r="2" fill="var(--bg)" stroke="var(--accent)" strokeWidth="1.3" />
      <circle cx="12" cy="12" r="3.4" fill="var(--accent)" />
    </svg>
  );
}
