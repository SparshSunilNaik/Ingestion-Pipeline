"use client";

import type { EvidenceRef, Report, Section } from "@/lib/api";
import { api } from "@/lib/api";
import { Badge, BasisBadge, Card } from "@/components/ui";

function downloadJson(data: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export type OpenEvidence = (ref: { path: string; start: number; end: number; id?: string }) => void;

function SectionBlock({ section, evidence, onOpen }: { section: Section; evidence: Map<string, EvidenceRef>; onOpen: OpenEvidence }) {
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold">{section.title}</h4>
      <ul className="space-y-2">
        {section.claims.map((c, i) => (
          <li key={i} className="rounded-md border border-border bg-surface px-3 py-2 text-sm">
            <div className="flex items-start justify-between gap-3">
              <p className={c.basis === "unsupported" ? "text-muted line-through decoration-bad/40" : ""}>{c.statement}</p>
              <BasisBadge basis={c.basis} />
            </div>
            {c.note ? <p className="mt-1 text-xs text-muted">{c.note}</p> : null}
            {c.evidence_ids.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {c.evidence_ids.map((id) => {
                  const ev = evidence.get(id);
                  return ev ? (
                    <button
                      key={id}
                      onClick={() => onOpen({ path: ev.path, start: ev.start_line, end: ev.end_line, id })}
                      className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-accent hover:underline"
                      title={`${ev.category} · ${ev.source_kind} · ${ev.verification_status}`}
                    >
                      {ev.path}:{ev.start_line}
                      {ev.end_line !== ev.start_line ? `-${ev.end_line}` : ""}
                    </button>
                  ) : (
                    <code key={id} className="text-[11px] text-muted">{id}</code>
                  );
                })}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

const GROUPS: { key: keyof Pick<Report["content"], "overview" | "installation" | "architecture" | "code_structure" | "engineering">; title: string }[] = [
  { key: "overview", title: "Repository overview" },
  { key: "installation", title: "Installation and usage" },
  { key: "architecture", title: "Architecture" },
  { key: "code_structure", title: "Code structure" },
  { key: "engineering", title: "Engineering assessment" },
];

export function ReportView({ report, onOpen }: { report: Report; onOpen: OpenEvidence }) {
  const c = report.content;
  const evidence = new Map(c.evidence.map((e) => [e.id, e]));
  const validation = (report.usage?.validation ?? null) as Record<string, unknown> | null;
  return (
    <div className="space-y-6">
      <Card
        title={c.kind === "agent" ? `Agent report (${c.model})` : "Deterministic report"}
        actions={
          <div className="flex gap-3 text-sm">
            <a className="text-accent hover:underline" href={api.reportMarkdownUrl(report.id)}>Markdown</a>
            <button className="text-accent hover:underline" onClick={() => downloadJson(c, `report-${report.id}.json`)}>
              JSON
            </button>
          </div>
        }
      >
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge>commit {c.commit_sha.slice(0, 12)}</Badge>
          <Badge>{c.evidence_summary.referenced ?? 0} evidence refs</Badge>
          <Badge tone="ok">{c.evidence_summary.verified ?? 0} verified</Badge>
          {c.evidence_summary.invalid ? <Badge tone="bad">{c.evidence_summary.invalid} invalid</Badge> : null}
          {c.coverage.is_partial ? <Badge tone="warn">partial coverage</Badge> : <Badge tone="ok">full coverage within limits</Badge>}
          {validation ? (
            <>
              <Badge tone="accent">{String(validation.claims)} agent claims</Badge>
              {Number(validation.unsupported_claims) > 0 ? <Badge tone="bad">{String(validation.unsupported_claims)} unsupported</Badge> : null}
              {Number(validation.documentation_only_claims) > 0 ? <Badge tone="warn">{String(validation.documentation_only_claims)} docs-only</Badge> : null}
            </>
          ) : null}
        </div>
        <p className="mt-2 text-xs text-muted">
          Every statement shows its basis. &ldquo;docs claim&rdquo; statements rest only on documentation; &ldquo;heuristic&rdquo; statements are judgements, not proven facts. Click a location to open the exact source range.
        </p>
      </Card>

      {c.agent_narrative.length > 0 ? (
        <Card title="Agent narrative">
          <div className="space-y-5">
            {c.agent_narrative.map((s) => (
              <SectionBlock key={s.title} section={s} evidence={evidence} onOpen={onOpen} />
            ))}
          </div>
        </Card>
      ) : null}

      {GROUPS.map((g) => (
        <Card key={g.key} title={g.title}>
          <div className="space-y-5">
            {c[g.key].map((s) => (
              <SectionBlock key={s.title} section={s} evidence={evidence} onOpen={onOpen} />
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
