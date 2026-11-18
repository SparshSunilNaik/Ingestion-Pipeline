"""Markdown export of a Report."""

from __future__ import annotations

from app.reports.schema import Report, Section

_BASIS_LABEL = {
    "source_evidence": "source",
    "configuration_evidence": "config",
    "documentation_claim": "docs claim",
    "inventory_measured": "measured",
    "heuristic": "heuristic",
    "unknown": "unknown",
    "unsupported": "UNSUPPORTED",
}


def _esc(text: str) -> str:
    return text.replace("\r", " ").replace("\n", " ")


def _section(lines: list[str], s: Section, loc: dict[str, str]) -> None:
    lines.append(f"### {s.title}\n")
    for c in s.claims:
        refs = " ".join(f"[{i}]({loc[i]})" if i in loc else f"`{i}`" for i in c.evidence_ids)
        note = f" — _{_esc(c.note)}_" if c.note else ""
        lines.append(f"- {_esc(c.statement)} `[{_BASIS_LABEL.get(c.basis, c.basis)}]`{note}{(' ' + refs) if refs else ''}")
    lines.append("")


def render_markdown(report: Report) -> str:
    loc = {e.id: f"#{e.id}" for e in report.evidence}
    lines = [
        f"# Repository report: {report.repository}",
        "",
        f"- URL: {report.canonical_url}",
        f"- Commit: `{report.commit_sha}` (branch {report.default_branch or 'unknown'})",
        f"- Report kind: {report.kind}" + (f" (model `{report.model}`)" if report.model else ""),
        f"- Generated: {report.generated_at}",
        f"- Coverage: {report.coverage.get('analyzed_files', 0)} of {report.coverage.get('tracked_files', 0)} tracked files analysed"
        + (" — **PARTIAL**" if report.coverage.get("is_partial") else ""),
        "",
        "> Labels: `source` = cites implementation code; `config` = manifests/config only; `docs claim` = documentation only, "
        "not verified against code; `measured` = inventory statistic; `heuristic` = judgement, not proven; `UNSUPPORTED` = model claim without valid evidence.",
        "",
    ]
    if report.agent_narrative:
        lines.append("## Agent narrative\n")
        for s in report.agent_narrative:
            _section(lines, s, loc)
    for title, group in (
        ("Repository overview", report.overview),
        ("Installation and usage", report.installation),
        ("Architecture", report.architecture),
        ("Code structure", report.code_structure),
        ("Engineering assessment", report.engineering),
    ):
        lines.append(f"## {title}\n")
        for s in group:
            _section(lines, s, loc)
    lines.append("## Evidence\n")
    lines.append(f"Summary: {report.evidence_summary}\n")
    lines.append("| ID | Location | Category | Kind | Status |")
    lines.append("|---|---|---|---|---|")
    for e in report.evidence:
        lines.append(f'| <a id="{e.id}"></a>`{e.id}` | `{e.path}`:{e.start_line}-{e.end_line} | {e.category} | {e.source_kind} | {e.verification_status} |')
    lines.append("")
    return "\n".join(lines)
