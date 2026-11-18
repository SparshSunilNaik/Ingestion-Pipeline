"use client";

import { Bot, CircleExclamationPoint, LoaderCircle, MessagesSquare, Plus, Send, Square, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type Message, type Snapshot } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { Badge, Button, EmptyState, ErrorState, Kbd, SkeletonRows, cn, formatTime } from "@/components/ui";
import { ClaimList } from "@/components/workspace/claims";
import { useNav } from "@/components/workspace/nav";

const EXAMPLES = [
  "What happens when a request reaches the main API entry point?",
  "Where is the most referenced function called?",
  "Which files would be affected if the core service class changes?",
  "How is configuration loaded?",
];

const GROUNDING: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "neutral"; help: string }> = {
  grounded: { label: "grounded", tone: "ok", help: "Every claim cites verified evidence from this snapshot" },
  partially_grounded: { label: "partially grounded", tone: "warn", help: "Some claims lack valid evidence and are marked unsupported" },
  unsupported: { label: "unsupported", tone: "bad", help: "No claim cites valid evidence" },
  insufficient_evidence: { label: "insufficient evidence", tone: "warn", help: "The assistant reported it could not answer from the available evidence" },
};

export function Investigate({ snapshot: s }: { snapshot: Snapshot }) {
  const nav = useNav();
  const convs = useAsync(() => api.conversations(s.id), [s.id]);
  const agent = useAsync(() => api.agentStatus(), []);
  const current = Number(nav.param("c")) || convs.data?.[0]?.id || null;
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);

  async function newConversation() {
    setCreating(true);
    setCreateError(null);
    try {
      const c = await api.createConversation(s.id);
      convs.reload();
      nav.setParams({ c: String(c.id) });
    } catch (e) {
      setCreateError(e);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
          <span className="text-[11.5px] font-semibold tracking-wide text-fg-2 uppercase">Investigations</span>
          <Button size="sm" variant="ghost" onClick={newConversation} disabled={creating} aria-label="New investigation"><Plus className="h-3.5 w-3.5" /> New</Button>
        </div>
        {createError ? <div className="p-2"><ErrorState error={createError} compact /></div> : null}
        <ul className="min-h-0 flex-1 overflow-auto py-1">
          {!convs.data && <li className="p-3"><SkeletonRows rows={4} /></li>}
          {convs.data?.length === 0 && <li className="px-3 py-2 text-[12px] text-fg-3">No investigations for this commit yet.</li>}
          {(convs.data ?? []).map((c) => (
            <li key={c.id}>
              <button onClick={() => nav.setParams({ c: String(c.id) })} className={cn("w-full px-3 py-2 text-left", c.id === current ? "bg-accent-soft" : "hover:bg-panel-3")}>
                <div className={cn("truncate text-[12.5px]", c.id === current && "text-accent")}>{c.title}</div>
                <div className="truncate font-mono text-[10.5px] text-fg-3">{c.model} · {formatTime(c.updated_at)}</div>
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-line p-3 text-[11.5px] leading-relaxed text-fg-3">
          Answers are restricted to evidence from commit <code className="font-mono text-fg-2">{s.commit_sha.slice(0, 10)}</code>. The model has no tool access; it can only request read-only evidence. Every citation is re-verified.
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {agent.data && !agent.data.agent_ready && (
          <div className="flex shrink-0 items-center gap-2 border-b border-line bg-warn-soft px-4 py-2 text-[12.5px] text-warn" role="status">
            <CircleExclamationPoint className="h-4 w-4" aria-hidden /> Agent unavailable: {agent.data.error ?? "OpenCode is not ready"}. Deterministic views still work.
          </div>
        )}
        {current ? (
          <Thread key={current} conversationId={current} agentReady={!!agent.data?.agent_ready} />
        ) : (
          <EmptyState icon={<MessagesSquare className="h-6 w-6" />} title="Start an investigation" action={<Button variant="primary" onClick={newConversation} disabled={creating}><Plus className="h-3.5 w-3.5" /> New investigation</Button>}>
            Ask how something works, where it is used or what a change could affect. Answers cite exact source lines.
          </EmptyState>
        )}
      </div>
    </div>
  );
}

function Thread({ conversationId, agentReady }: { conversationId: number; agentReady: boolean }) {
  const nav = useNav();
  const [poll, setPoll] = useState(false);
  const conv = useAsync(() => api.conversation(conversationId), [conversationId], poll ? 2000 : null);
  const messages = conv.data?.messages ?? [];
  const pending = messages.find((m) => m.status === "pending");
  if (!!pending !== poll) setPoll(!!pending);
  const [draft, setDraft] = useState(() => nav.param("q") ?? "");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending?.status]);

  async function send(text: string) {
    const content = text.trim();
    if (content.length < 2) return;
    setSending(true);
    setSendError(null);
    try {
      await api.ask(conversationId, content);
      setDraft("");
      nav.setParams({ q: null });
      setPoll(true);
      conv.reload();
    } catch (e) {
      setSendError(e);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-4 py-2">
        <span className="min-w-0 truncate text-[13px] font-medium">{conv.data?.title ?? "…"}</span>
        {conv.data && <Badge tone="info" title="Model fixed for this investigation">{conv.data.model}</Badge>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[900px] space-y-4 p-4">
          {conv.error ? <ErrorState error={conv.error} onRetry={conv.reload} /> : null}
          {!conv.data && !conv.error && <SkeletonRows rows={6} />}
          {conv.data && messages.length === 0 && (
            <div className="space-y-2">
              <p className="text-[12.5px] text-fg-3">Try a repository-grounded question:</p>
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((e) => (
                  <button key={e} onClick={() => setDraft(e)} className="rounded-md border border-line bg-panel-2 px-2.5 py-1.5 text-left text-[12.5px] text-fg-2 hover:border-accent hover:text-fg">{e}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (m.role === "user" ? <UserTurn key={m.id} m={m} /> : <AssistantTurn key={m.id} m={m} onRetry={() => send(messages[messages.indexOf(m) - 1]?.content ?? "")} />))}
          <div ref={endRef} />
        </div>
      </div>
      <div className="shrink-0 border-t border-line bg-panel p-3">
        <div className="mx-auto max-w-[900px]">
          {sendError ? <div className="mb-2"><ErrorState error={sendError} compact /></div> : null}
          <form onSubmit={(e) => { e.preventDefault(); void send(draft); }} className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(draft);
                }
              }}
              rows={2}
              maxLength={2000}
              disabled={!agentReady || !!pending}
              placeholder={!agentReady ? "Agent unavailable — see Settings" : pending ? "Investigating…" : "Ask about this repository…"}
              aria-label="Question"
              className="min-h-[44px] flex-1 resize-none rounded-md border border-line bg-panel-2 px-3 py-2 text-[13px] outline-none placeholder:text-fg-3 focus:border-accent disabled:opacity-60"
            />
            {pending ? (
              <Button variant="danger" onClick={() => pending.job_id && api.cancelJob(pending.job_id).then(conv.reload)} aria-label="Cancel investigation"><Square className="h-3.5 w-3.5" /> Cancel</Button>
            ) : (
              <Button type="submit" variant="primary" disabled={!agentReady || sending || draft.trim().length < 2} aria-label="Send question"><Send className="h-3.5 w-3.5" /> Ask</Button>
            )}
          </form>
          <div className="mt-1 text-[11px] text-fg-3"><Kbd>Enter</Kbd> to send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> for a new line · follow-up questions keep this conversation&apos;s context</div>
        </div>
      </div>
    </>
  );
}

function UserTurn({ m }: { m: Message }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-panel-3 text-fg-2"><User className="h-3.5 w-3.5" /></span>
      <p className="pt-0.5 text-[13.5px] whitespace-pre-wrap">{m.content}</p>
    </div>
  );
}

function AssistantTurn({ m, onRetry }: { m: Message; onRetry: () => void }) {
  const p = m.payload ?? {};
  const g = p.grounding ? GROUNDING[p.grounding] : null;
  return (
    <div className="flex gap-3" data-testid="assistant-turn">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent"><Bot className="h-3.5 w-3.5" /></span>
      <div className="min-w-0 flex-1 rounded-lg border border-line bg-panel p-3">
        {m.status === "pending" && (
          <div className="flex items-center gap-2 text-[12.5px] text-fg-3" role="status">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Retrieving evidence and investigating…
          </div>
        )}
        {(m.status === "failed" || m.status === "cancelled") && (
          <ErrorState error={m.status === "cancelled" ? "Investigation cancelled." : m.content || "The investigation failed."} onRetry={onRetry} />
        )}
        {m.status === "complete" && (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {g && <Badge tone={g.tone} title={g.help}>{g.label}</Badge>}
              {p.intents?.map((i) => <Badge key={i}>{i}</Badge>)}
              <span className="ml-auto font-mono text-[10.5px] text-fg-3">
                {p.model}{p.usage?.model_calls ? ` · ${p.usage.model_calls} call${p.usage.model_calls > 1 ? "s" : ""}` : ""}{p.usage?.latency_ms ? ` · ${(p.usage.latency_ms / 1000).toFixed(1)}s` : ""}{p.usage?.gateway?.requests ? ` · ${p.usage.gateway.requests} evidence reads` : ""}
              </span>
            </div>
            <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap">{m.content}</p>
            {p.claims && p.claims.length > 0 && (
              <div className="mt-3 border-t border-line pt-2">
                <div className="mb-1 text-[11px] font-semibold tracking-wide text-fg-3 uppercase">Evidence-backed claims</div>
                <ClaimList claims={p.claims} />
              </div>
            )}
            {p.limitations && p.limitations.length > 0 && (
              <div className="mt-2 border-t border-line pt-2">
                <div className="mb-1 text-[11px] font-semibold tracking-wide text-fg-3 uppercase">Limitations</div>
                <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-fg-2">{p.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
