"use client";

import { Bot, KeyRound, Palette, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAsync, usePref } from "@/lib/hooks";
import { SHORTCUTS } from "@/components/shell/app-shell";
import { Badge, Button, EmptyState, ErrorState, IconButton, Kbd, Panel, Segmented, SkeletonRows, StatusDot } from "@/components/ui";

export function SettingsView() {
  const router = useRouter();
  const status = useAsync(() => api.agentStatus(), []);
  const models = useAsync(() => api.agentModels(), []);
  const auth = useAsync(() => api.authStatus(), []);
  const ready = useAsync(() => api.ready(), []);
  const [theme, setTheme] = usePref("ip.theme", "dark");
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const visible = useMemo(() => (models.data ?? []).filter((m) => m.id.toLowerCase().includes(filter.toLowerCase())), [models.data, filter]);
  const s = status.data;

  async function select(id: string) {
    setSaving(id);
    setSaveError(null);
    try {
      await api.selectModel(id);
      status.reload();
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="mx-auto grid max-w-[1300px] gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel title="OpenCode runtime" icon={<Bot className="h-3.5 w-3.5" />} actions={<IconButton label="Refresh status" onClick={status.reload}><RefreshCw className="h-3.5 w-3.5" /></IconButton>}>
          {status.error ? <ErrorState error={status.error} onRetry={status.reload} /> : null}
          {!s && !status.error && <SkeletonRows rows={4} />}
          {s && (
            <dl className="grid gap-x-6 gap-y-3 text-[12.5px] sm:grid-cols-3">
              <Field label="Connection"><StatusDot tone={s.available ? "ok" : "bad"} /> {s.available ? "connected" : "unavailable"}</Field>
              <Field label="Mode">{s.mode}</Field>
              <Field label="Version"><span className="font-mono">{s.version ?? "—"}</span></Field>
              <Field label="Selected model"><span className="font-mono">{s.selected_model}</span></Field>
              <Field label="Model available">{s.selected_model_available == null ? "unknown" : s.selected_model_available ? <Badge tone="ok">yes</Badge> : <Badge tone="bad">no</Badge>}</Field>
              <Field label="Agent">{s.agent_ready ? <Badge tone="ok">ready</Badge> : <Badge tone="warn">not ready</Badge>}</Field>
              {s.error && <div className="sm:col-span-3"><ErrorState error={s.error} compact /></div>}
            </dl>
          )}
          <p className="mt-3 text-[11.5px] text-fg-3">
            The agent uses OpenCode&apos;s stateless generation endpoint without any tools. All repository reads go through the backend&apos;s read-only evidence gateway.
            Provider credentials stay inside OpenCode and are never shown here. Models are never switched automatically.
          </p>
        </Panel>
        <Panel title={`Available models${models.data ? ` (${models.data.length})` : ""}`} bodyClassName="p-0">
          <div className="border-b border-line p-2">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter models" aria-label="Filter models" className="h-8 w-full max-w-sm rounded-md border border-line bg-panel-2 px-2.5 text-[12.5px] outline-none focus:border-accent" />
          </div>
          {models.error ? <div className="p-3"><ErrorState error={models.error} onRetry={models.reload} /></div> : null}
          {saveError ? <div className="p-3"><ErrorState error={saveError} compact /></div> : null}
          {!models.data && !models.error && <div className="p-3"><SkeletonRows /></div>}
          {models.data && visible.length === 0 && <EmptyState title="No models match" />}
          <div className="max-h-[480px] overflow-auto">
            <table className="w-full text-[12.5px]">
              <tbody className="divide-y divide-line">
                {visible.map((m) => (
                  <tr key={m.id} className="hover:bg-panel-2">
                    <td className="px-3 py-1.5 font-mono text-[12px]">{m.id}</td>
                    <td className="px-3 py-1.5 text-fg-2">{m.name} {!m.enabled && <Badge tone="warn">disabled</Badge>}</td>
                    <td className="px-3 py-1.5 font-mono text-fg-3">{m.context_limit ? `${Math.round(m.context_limit / 1000)}k ctx` : ""}</td>
                    <td className="px-3 py-1.5 text-right">
                      {s?.selected_model === m.id ? (
                        <Badge tone="accent">selected</Badge>
                      ) : (
                        <Button size="sm" disabled={!m.enabled || saving !== null} onClick={() => select(m.id)} aria-label={`Select ${m.id}`}>
                          {saving === m.id ? "Saving…" : "Select"}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Panel title="Session & security" icon={<KeyRound className="h-3.5 w-3.5" />}>
          <dl className="space-y-2 text-[12.5px]">
            <Field label="Authentication">{auth.data ? `${auth.data.auth_mode} · ${auth.data.method ?? "—"}` : "…"}</Field>
            <Field label="Worker">{ready.data ? <><StatusDot tone={ready.data.worker_running ? "ok" : "bad"} /> {String(ready.data.agent.worker_mode ?? "")} · {ready.data.worker_running ? "running" : "not running"}</> : "…"}</Field>
          </dl>
          <Button className="mt-3" onClick={() => api.logout().finally(() => router.replace("/login"))}>Sign out</Button>
        </Panel>
        <Panel title="Appearance" icon={<Palette className="h-3.5 w-3.5" />}>
          <Segmented label="Theme" value={theme === "light" ? "light" : "dark"} onChange={setTheme} options={[{ id: "dark", label: "Dark" }, { id: "light", label: "Light" }]} />
        </Panel>
        <Panel title="Keyboard shortcuts">
          <dl className="space-y-2 text-[12.5px]">
            {SHORTCUTS.map(([k, d]) => (
              <div key={k} className="flex items-center justify-between gap-3">
                <dt className="text-fg-2">{d}</dt>
                <dd className="flex shrink-0 gap-1">{k.split(" ").map((p) => <Kbd key={p}>{p}</Kbd>)}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] tracking-wide text-fg-3 uppercase">{label}</dt>
      <dd className="mt-0.5 flex items-center gap-1.5">{children}</dd>
    </div>
  );
}
