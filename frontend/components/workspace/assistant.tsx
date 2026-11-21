"use client";

import { Bot, ChevronDown, CircleExclamationPoint, Crosshair, History, LoaderCircle, Plus, Send, Settings2, Square, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, type AgentStatus, type Conversation, type Message } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { ACTIONS, actionsFor, questionFor } from "@/components/workspace/actions";
import { EvidenceList, useNav } from "@/components/workspace/nav";
import { Badge, BasisBadge, Button, ErrorState, IconButton, Kbd, SkeletonRows, cn, formatTime } from "@/components/ui";

const GROUNDING: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "neutral"; help: string }> = {
  grounded: { label: "grounded in source", tone: "ok", help: "Every claim cites evidence that was re-verified against this commit" },
  partially_grounded: { label: "partly grounded", tone: "warn", help: "Some claims lack valid evidence and are marked unsupported" },
  unsupported: { label: "unsupported", tone: "bad", help: "No claim cites valid evidence — treat the answer as unverified" },
  insufficient_evidence: { label: "not enough evidence", tone: "warn", help: "The assistant said it could not answer from the available evidence" },
};

const STARTERS = [
  "What does this repository do, and what are its main components?",
  "What are the main entry points and what happens when they run?",
  "Which parts of the code are most central, and why?",
];

export function Assistant() {
  const nav = useNav();
  const sid = nav.snapshotId;
  const convs = useAsync(() => api.conversations(sid), [sid]);
  const agent = useAsync(() => api.agentStatus().catch(() => null), [], 30_000);
  const requested = Number(nav.param("c")) || null;
  // Only conversations of this snapshot are selectable: a `c` from another snapshot is ignored.
  const current = requested && convs.data?.some((c) => c.id === requested) ? requested : null;
  const [showHistory, setShowHistory] = useState(false);
  const a = agent.data ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="Investigation assistant">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        <Bot className="ml-1 h-4 w-4 text-accent" aria-hidden />
        <span className="text-[12.5px] font-semibold">Assistant</span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton label="Investigation history" onClick={() => setShowHistory(!showHistory)} active={showHistory}>
            <History className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="New investigation" onClick={() => { nav.setParams({ c: null }); setShowHistory(false); }}>
            <Plus className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="Close assistant (Ctrl+I)" onClick={() => nav.setAssistantOpen(false)}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>
      {a && !a.agent_ready && (
        <div className="shrink-0 border-b border-line bg-warn-soft px-3 py-2 text-[12px] text-warn" role="status">
          <div className="flex items-start gap-1.5">
            <CircleExclamationPoint className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            <div>
              <span className="font-medium">The AI model is not available.</span> {a.error ?? (a.selected_model_available === false ? `Model ${a.selected_model} is not offered by OpenCode.` : "OpenCode is not ready.")}{" "}
              Code, graph, flow and impact views still work. <Link href="/settings" className="underline">Check settings</Link>
            </div>
          </div>
        </div>
      )}
      {showHistory ? (
        <HistoryList conversations={convs.data} error={convs.error} current={current} onPick={(id) => { nav.setParams({ c: String(id) }); setShowHistory(false); }} />
      ) : (
        <Thread key={`${sid}:${current ?? "new"}`} conversationId={current} agent={a} onCreated={(id) => { convs.reload(); nav.setParams({ c: String(id) }); }} conversations={convs.data} />
      )}
    </div>
  );
}

function HistoryList({ conversations, error, current, onPick }: { conversations?: Conversation[]; error?: unknown; current: number | null; onPick: (id: number) => void }) {
  if (error) return <div className="p-3"><ErrorState error={error} compact /></div>;
  if (!conversations) return <div className="p-3"><SkeletonRows rows={4} /></div>;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <p className="px-3 pt-2 pb-1 text-[11px] text-fg-3">Investigations of this commit. Each keeps its own context and model.</p>
      {conversations.length === 0 && <p className="px-3 py-2 text-[12.5px] text-fg-3">None yet.</p>}
      <ul>
        {conversations.map((c) => (
          <li key={c.id}>
            <button onClick={() => onPick(c.id)} className={cn("block w-full px-3 py-2 text-left", c.id === current ? "bg-accent-soft" : "hover:bg-panel-3")}>
              <div className={cn("truncate text-[12.5px]", c.id === current && "text-accent")}>{c.title}</div>
              <div className="truncate font-mono text-[10.5px] text-fg-3">{c.model} · {formatTime(c.updated_at)}</div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ModelPicker({ agent, value, onChange }: { agent: AgentStatus | null; value: string; onChange: (m: string) => void }) {
  const models = useAsync(() => (agent?.available ? api.agentModels().catch(() => []) : Promise.resolve([])), [agent?.available]);
  const options = [...new Set([value, ...(models.data ?? []).filter((m) => m.enabled).map((m) => m.id)])].filter(Boolean);
  return (
    <label className="flex min-w-0 items-center gap-1 text-[11px] text-fg-3" title="The model is fixed per investigation; it is never switched automatically.">
      <Settings2 className="h-3 w-3 shrink-0" aria-hidden />
      <span className="sr-only">Model for a new investigation</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="min-w-0 truncate rounded border border-line bg-panel-2 px-1 py-0.5 font-mono text-[11px] text-fg-2" aria-label="Model for a new investigation">
        {options.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
    </label>
  );
}

function Thread({ conversationId, agent, onCreated, conversations }: { conversationId: number | null; agent: AgentStatus | null; onCreated: (id: number) => void; conversations?: Conversation[] }) {
  const nav = useNav();
  const [poll, setPoll] = useState(false);
  const conv = useAsync(() => (conversationId ? api.conversation(conversationId) : Promise.resolve(null)), [conversationId], poll ? 1500 : null);
  const messages = conv.data?.messages ?? [];
  const pending = messages.find((m) => m.status === "pending");
  // Poll only while an answer is being produced (adjusting state during render, not in an effect).
  if (poll !== !!pending && !(poll && conv.loading)) setPoll(!!pending);
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ready = !!agent?.agent_ready;
  const chosenModel = model || agent?.selected_model || "";

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending?.status]);

  // Attached context: the current selection, unless the user detached it for this selection.
  const sel = nav.selection;
  const [detachedKey, setDetachedKey] = useState<string | null>(null);
  const attached = sel && sel.key !== detachedKey ? sel : null;

  async function send(text: string, contextKey: string | null = attached?.key ?? null) {
    const content = text.trim();
    if (content.length < 2 || sending) return;
    setSending(true);
    setSendError(null);
    try {
      let id = conversationId;
      if (!id) {
        const c = await api.createConversation(nav.snapshotId, chosenModel || undefined);
        id = c.id;
      }
      await api.ask(id, content, contextKey);
      setDraft("");
      setPoll(true);
      if (id !== conversationId) onCreated(id);
      else conv.reload();
    } catch (e) {
      setSendError(e);
    } finally {
      setSending(false);
    }
  }

  // Requests from the canvas ("Explain this", "Trace execution"…) arrive through a registered handler.
  const { setAsker } = nav;
  useEffect(() => {
    setAsker((question, submit) => {
      if (submit && ready && !pending) void send(question);
      else {
        setDraft(question);
        inputRef.current?.focus();
      }
    });
    return () => setAsker(null);
  });

  const title = conv.data?.title ?? (conversationId ? conversations?.find((c) => c.id === conversationId)?.title : null);

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg-2" title={title ?? undefined}>{title ?? "New investigation"}</span>
        {conv.data ? (
          <Badge tone="info" title="Model fixed for this investigation">{conv.data.model}</Badge>
        ) : (
          <ModelPicker agent={agent} value={chosenModel} onChange={setModel} />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto" aria-live="polite">
        <div className="space-y-4 p-3">
          {conv.error ? <ErrorState error={conv.error} onRetry={conv.reload} /> : null}
          {conversationId && !conv.data && !conv.error && <SkeletonRows rows={5} />}
          {(!conversationId || (conv.data && messages.length === 0)) && (
            <div className="space-y-3 pt-1">
              <p className="text-[12.5px] leading-relaxed text-fg-2">
                Ask about <span className="font-medium text-fg">{nav.snapshot.repository.name}</span> at commit{" "}
                <code className="font-mono text-[11.5px]">{nav.snapshot.commit_sha.slice(0, 10)}</code>. Answers cite exact source lines; the model cannot run code or read anything except evidence the backend retrieves.
              </p>
              <div className="flex flex-col gap-1.5">
                {STARTERS.map((q) => (
                  <button key={q} disabled={!ready} onClick={() => void send(q)} className="rounded-md border border-line bg-panel-2 px-2.5 py-1.5 text-left text-[12.5px] text-fg-2 hover:border-accent hover:text-fg disabled:opacity-50">
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) =>
            m.role === "user" ? <UserTurn key={m.id} m={m} /> : <AssistantTurn key={m.id} m={m} onRetry={() => void send(messages[i - 1]?.content ?? "")} onCancel={() => m.job_id && api.cancelJob(m.job_id).then(conv.reload, conv.reload)} />,
          )}
          <div ref={endRef} />
        </div>
      </div>
      <div className="shrink-0 border-t border-line p-2.5">
        {sel && (
          <div className="mb-2">
            <div className="mb-1.5 flex items-center gap-1.5">
              {attached ? (
                <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-[var(--accent-line)] bg-accent-soft py-0.5 pr-1 pl-2" title={`Sent with your question and validated by the backend: ${attached.key}`}>
                  <Crosshair className="h-3 w-3 shrink-0 text-accent" aria-hidden />
                  <span className="atlas-label !text-accent">attached</span>
                  <span className="min-w-0 truncate font-mono text-[11.5px] text-fg">{attached.label}</span>
                  <button type="button" onClick={() => setDetachedKey(attached.key)} aria-label={`Detach ${attached.label}`} className="rounded p-0.5 text-fg-3 hover:bg-panel-3 hover:text-fg">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ) : (
                <button type="button" onClick={() => setDetachedKey(null)} className="inline-flex items-center gap-1 rounded-md border border-dashed border-line px-2 py-0.5 font-mono text-[11px] text-fg-3 hover:border-[var(--accent-line)] hover:text-fg">
                  <Crosshair className="h-3 w-3" aria-hidden /> attach {sel.label}
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              {actionsFor(sel).map((id) => {
                const A = ACTIONS[id];
                return (
                  <button
                    key={id}
                    disabled={!ready || !!pending || sending}
                    onClick={() => void send(questionFor(id, sel), sel.key)}
                    className="inline-flex h-6 items-center gap-1 rounded-full border border-line px-2 text-[11.5px] text-fg-2 hover:border-accent hover:text-fg disabled:opacity-50"
                  >
                    <A.icon className="h-3 w-3" aria-hidden /> {A.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {sendError ? <div className="mb-2"><ErrorState error={sendError} compact /></div> : null}
        <form onSubmit={(e) => { e.preventDefault(); void send(draft); }} className="flex items-end gap-1.5">
          <textarea
            ref={inputRef}
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
            disabled={!ready || !!pending}
            placeholder={!ready ? "The AI model is unavailable" : pending ? "Investigating…" : conversationId ? "Ask a follow-up…" : "Ask about this repository…"}
            aria-label="Question for the assistant"
            className="min-h-[44px] flex-1 resize-none rounded-md border border-line bg-panel-2 px-2.5 py-2 text-[13px] outline-none placeholder:text-fg-3 focus:border-accent disabled:opacity-60"
          />
          {pending ? (
            <Button variant="danger" onClick={() => pending.job_id && api.cancelJob(pending.job_id).then(conv.reload, conv.reload)} aria-label="Cancel the running investigation">
              <Square className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : (
            <Button type="submit" variant="primary" disabled={!ready || sending || draft.trim().length < 2} aria-label="Send question">
              {sending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="h-3.5 w-3.5" aria-hidden />}
            </Button>
          )}
        </form>
        <div className="mt-1 truncate text-[10.5px] text-fg-3" title="Enter sends; Shift+Enter adds a line. Follow-up questions keep this investigation's context.">
          <Kbd>Enter</Kbd> to send · follow-ups keep context
        </div>
      </div>
    </>
  );
}

function UserTurn({ m }: { m: Message }) {
  const ctx = m.payload?.context;
  return (
    <header className="atlas-in border-t border-line pt-3 first:border-t-0 first:pt-0">
      <span className="atlas-label">question</span>
      <h3 className="mt-0.5 text-[14px] leading-snug font-semibold whitespace-pre-wrap text-fg">{m.content}</h3>
      {ctx && (
        <span className="mt-1 inline-flex max-w-full items-center gap-1 font-mono text-[11px] text-fg-3" title={ctx.key}>
          <Crosshair className="h-3 w-3 shrink-0 text-accent" aria-hidden /> about <span className="truncate text-fg-2">{ctx.label ?? ctx.key}</span>
        </span>
      )}
    </header>
  );
}

const QA_STAGES: Record<string, string> = {
  queued: "Waiting for the worker",
  starting: "Starting",
  retrieving: "Retrieving evidence from the snapshot",
  investigating: "Reading code and writing the answer",
  validating: "Re-verifying every citation",
};

function PendingAnswer({ jobId, onCancel }: { jobId: number | null; onCancel: () => void }) {
  const job = useAsync(() => (jobId ? api.job(jobId) : Promise.resolve(null)), [jobId], 1500);
  const stage = job.data?.stage ?? "queued";
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2 text-[12.5px] text-fg-2" role="status">
      <LoaderCircle className="h-3.5 w-3.5 animate-spin text-accent" aria-hidden />
      <span>{QA_STAGES[stage] ?? stage}…</span>
      <button onClick={onCancel} className="ml-auto text-[11.5px] text-fg-3 underline-offset-2 hover:text-fg hover:underline">Cancel</button>
    </div>
  );
}

function AssistantTurn({ m, onRetry, onCancel }: { m: Message; onRetry: () => void; onCancel: () => void }) {
  const p = m.payload ?? {};
  const g = p.grounding ? GROUNDING[p.grounding] : null;
  const [details, setDetails] = useState(false);
  const claims = p.claims ?? [];
  const supported = claims.filter((c) => c.basis !== "unsupported").length;
  return (
    <article className="atlas-fade -mt-1" data-testid="assistant-turn">
      {m.status === "pending" && <PendingAnswer jobId={m.job_id} onCancel={onCancel} />}
      {(m.status === "failed" || m.status === "cancelled") && (
        <ErrorState error={m.status === "cancelled" ? "Investigation cancelled." : m.content || "The investigation failed."} onRetry={onRetry} />
      )}
      {m.status === "complete" && (
        <>
          <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-fg">{m.content}</p>
          {claims.length > 0 && (
            <section className="mt-3">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="atlas-label">evidence</span>
                {g && <Badge tone={g.tone} title={g.help}>{g.label}</Badge>}
                <span className="font-mono text-[10.5px] text-fg-3">{supported}/{claims.length} statements cite verified source</span>
              </div>
              <ol className="space-y-1.5">
                {claims.map((c, i) => (
                  <li key={i} className="grid grid-cols-[18px_minmax(0,1fr)] gap-1.5">
                    <span className="pt-0.5 text-right font-mono text-[10.5px] text-fg-3">{i + 1}</span>
                    <div className="min-w-0">
                      <p className={cn("text-[12.5px] leading-relaxed", c.basis === "unsupported" ? "text-fg-3 line-through decoration-bad/50" : "text-fg-2")}>{c.statement}</p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1">
                        {c.basis !== "source_evidence" && <BasisBadge basis={c.basis} />}
                        <EvidenceList ids={c.evidence_ids} max={4} />
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {claims.length === 0 && g && <div className="mt-1.5"><Badge tone={g.tone} title={g.help}>{g.label}</Badge></div>}
          {p.limitations && p.limitations.length > 0 && (
            <section className="mt-3 border-l-2 border-warn/60 pl-2.5">
              <span className="atlas-label">uncertainty</span>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-[12px] text-fg-2">{p.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
            </section>
          )}
          <button onClick={() => setDetails(!details)} aria-expanded={details} className="mt-2 inline-flex items-center gap-0.5 font-mono text-[10.5px] text-fg-3 hover:text-fg">
            <ChevronDown className={cn("h-3 w-3 transition-transform", details && "rotate-180")} aria-hidden /> how this was answered
          </button>
          {details && (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md border border-line px-2.5 py-1.5 font-mono text-[11px] text-fg-2">
              <dt className="text-fg-3">model</dt><dd>{p.model ?? "—"}</dd>
              <dt className="text-fg-3">model calls</dt><dd>{p.usage?.model_calls ?? "—"}</dd>
              <dt className="text-fg-3">evidence reads</dt><dd>{p.usage?.gateway?.requests ?? "—"}</dd>
              <dt className="text-fg-3">latency</dt><dd>{p.usage?.latency_ms ? `${(p.usage.latency_ms / 1000).toFixed(1)} s` : "—"}</dd>
              <dt className="text-fg-3">intents</dt><dd>{p.intents?.join(", ") || "—"}</dd>
              <dt className="text-fg-3">grounding</dt><dd>{p.grounding ?? "—"}</dd>
            </dl>
          )}
        </>
      )}
    </article>
  );
}
