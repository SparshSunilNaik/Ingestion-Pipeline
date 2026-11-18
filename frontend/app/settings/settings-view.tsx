"use client";

import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { Badge, Button, Card, ErrorBox, Spinner } from "@/components/ui";

export function SettingsView() {
  const status = useAsync(() => api.agentStatus(), []);
  const models = useAsync(() => api.agentModels(), []);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);

  const visible = useMemo(() => (models.data ?? []).filter((m) => m.id.toLowerCase().includes(filter.toLowerCase())), [models.data, filter]);

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

  const s = status.data;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Agent settings</h1>
        <p className="text-sm text-muted">
          The agent runs through OpenCode&apos;s stateless generation API without tool access. Repository evidence is supplied by the backend&apos;s read-only gateway.
        </p>
      </div>

      <Card title="OpenCode runtime" actions={<Button variant="secondary" onClick={status.reload}>Refresh</Button>}>
        {status.error ? <ErrorBox error={status.error} /> : null}
        {!s && status.loading ? <Spinner /> : null}
        {s ? (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-muted">Mode</dt><dd>{s.mode}</dd></div>
            <div><dt className="text-xs text-muted">Connection</dt><dd>{s.available ? <Badge tone="ok">connected</Badge> : <Badge tone="bad">unavailable</Badge>}</dd></div>
            <div><dt className="text-xs text-muted">OpenCode version</dt><dd>{s.version ?? "—"}</dd></div>
            <div><dt className="text-xs text-muted">Endpoint</dt><dd className="font-mono text-xs">{s.base_url ?? "—"}</dd></div>
            <div><dt className="text-xs text-muted">Selected model</dt><dd className="font-mono text-xs">{s.selected_model}</dd></div>
            <div>
              <dt className="text-xs text-muted">Model available</dt>
              <dd>{s.selected_model_available === null ? "unknown" : s.selected_model_available ? <Badge tone="ok">yes</Badge> : <Badge tone="bad">no</Badge>}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs text-muted">Agent availability</dt>
              <dd>{s.agent_ready ? <Badge tone="ok">ready</Badge> : <Badge tone="warn">not ready</Badge>}</dd>
            </div>
            {s.error ? <div className="sm:col-span-2"><ErrorBox error={s.error} /></div> : null}
          </dl>
        ) : null}
        <p className="mt-3 text-xs text-muted">Credentials are managed by OpenCode and are never sent to this application or shown here.</p>
      </Card>

      <Card title={`Available models${models.data ? ` (${models.data.length})` : ""}`}>
        {models.error ? <ErrorBox error={models.error} /> : null}
        {!models.data && models.loading ? <Spinner /> : null}
        <ErrorBox error={saveError} />
        {models.data ? (
          <div className="space-y-3">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter models"
              className="w-full max-w-sm rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
            />
            <div className="max-h-[28rem] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface text-left text-xs text-muted">
                  <tr>
                    <th className="pb-2 font-medium">Model ID</th>
                    <th className="pb-2 font-medium">Name</th>
                    <th className="pb-2 font-medium">Context</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((m) => (
                    <tr key={m.id} className="border-t border-border">
                      <td className="py-1.5 font-mono text-xs">{m.id}</td>
                      <td className="py-1.5">{m.name} {!m.enabled ? <Badge tone="warn">disabled</Badge> : null}</td>
                      <td className="py-1.5 tabular-nums text-muted">{m.context_limit ? `${Math.round(m.context_limit / 1000)}k` : "—"}</td>
                      <td className="py-1.5 text-right">
                        {s?.selected_model === m.id ? (
                          <Badge tone="accent">selected</Badge>
                        ) : (
                          <Button variant="secondary" disabled={!m.enabled || saving !== null} onClick={() => void select(m.id)}>
                            {saving === m.id ? "Saving…" : "Select"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
