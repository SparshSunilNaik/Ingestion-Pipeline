"""Deterministic report builder: every statement is derived from persisted analysis rows."""

from __future__ import annotations

import posixpath
import re
from collections import Counter, defaultdict
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database.models import Dependency, Evidence, FileRecord, Finding, GraphEdge, Repository, Snapshot, Symbol
from app.database.models import Report as ReportRow
from app.evidence.verifier import SnapshotReader, verify_evidence
from app.reports.markdown import render_markdown
from app.reports.schema import Claim, EvidenceRef, Report, Section

_BADGE = re.compile(r"^\s*(\[!\[|!\[|<img|<p|<div|<a |<h\d|\[\!|<br)", re.I)


def _c(statement: str, basis: str, ids: list[str | None] | None = None, note: str | None = None) -> Claim:
    return Claim(statement=statement, basis=basis, evidence_ids=[i for i in (ids or []) if i], note=note)  # type: ignore[arg-type]


def _first_paragraph(text: str) -> str | None:
    paras = []
    in_fence = False
    buf: list[str] = []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if not s:
            if buf:
                paras.append(" ".join(buf))
                buf = []
            continue
        if s.startswith("#") or _BADGE.match(s) or set(s) <= set("=-*_ "):
            if buf:
                paras.append(" ".join(buf))
                buf = []
            continue
        buf.append(s)
    if buf:
        paras.append(" ".join(buf))
    for p in paras:
        if len(p) >= 30:
            return p[:600]
    return paras[0][:600] if paras else None


class ReportContext:
    def __init__(self, session: Session, snapshot: Snapshot) -> None:
        self.session = session
        self.snapshot = snapshot
        self.repo = session.get(Repository, snapshot.repository_id)
        sid = snapshot.id
        self.findings = list(session.scalars(select(Finding).where(Finding.snapshot_id == sid)))
        self.deps = list(session.scalars(select(Dependency).where(Dependency.snapshot_id == sid)))
        self.files = list(session.scalars(select(FileRecord).where(FileRecord.snapshot_id == sid)))
        self.reader = SnapshotReader(session, snapshot)

    def by_kind(self, kind: str) -> list[Finding]:
        return [f for f in self.findings if f.kind == kind]


def build_report_model(session: Session, snapshot: Snapshot, agent_sections: list[Section] | None = None, model: str | None = None) -> Report:
    ctx = ReportContext(session, snapshot)
    repo = ctx.repo
    assert repo is not None
    summary = snapshot.analysis_summary or {}
    inv = snapshot.inventory_summary or {}
    cov = snapshot.coverage or {}

    # ---------------- overview ----------------
    readme_secs = [f for f in ctx.by_kind("doc_section") if f.detail.get("is_readme")]
    readme_secs.sort(key=lambda f: (f.detail.get("path", "").count("/"), f.detail.get("start_line", 0)))
    purpose: list[Claim] = []
    for meta in ctx.by_kind("project_metadata"):
        if meta.detail.get("description"):
            purpose.append(_c(f"Manifest description ({meta.name}): {meta.detail['description']}", "configuration_evidence", [meta.evidence_id]))
    root_readme = [f for f in readme_secs if "/" not in f.detail.get("path", "/")] or readme_secs
    if root_readme:
        first_path = root_readme[0].detail["path"]
        text = "\n".join(ctx.reader.lines(first_path) or [])
        para = _first_paragraph(text)
        if para:
            sec = next((s for s in root_readme if s.detail["path"] == first_path), root_readme[0])
            purpose.append(_c(f"README states: {para}", "documentation_claim", [sec.evidence_id]))
    if not purpose:
        purpose.append(_c("No manifest description or README summary was found; purpose is not determined deterministically.", "unknown"))

    tech: list[Claim] = []
    langs = inv.get("languages_by_bytes", {})
    if langs:
        total = sum(langs.values()) or 1
        tech.append(_c("Languages (source+test bytes): " + ", ".join(f"{k} {v * 100 / total:.0f}%" for k, v in list(langs.items())[:8]), "inventory_measured"))
    for fw in sorted(ctx.by_kind("framework"), key=lambda f: (f.confidence != "observed", f.name)):
        if fw.confidence == "observed":
            tech.append(
                _c(
                    f"{fw.name} ({fw.detail.get('role')}) is imported in {fw.detail.get('import_sites')} place(s)"
                    + ("" if fw.detail.get("declared") else "; not found in a parsed manifest"),
                    "source_evidence",
                    [fw.evidence_id],
                )
            )
        else:
            tech.append(
                _c(
                    f"{fw.name} ({fw.detail.get('role')}) is declared as a dependency but no import was observed by the analyzer",
                    "configuration_evidence",
                    [fw.evidence_id],
                    "may be used via configuration, CLI or code paths the analyzer does not parse",
                )
            )

    features: list[Claim] = []
    for sec in readme_secs:
        if re.search(r"feature|capabilit|what (it|this) does", sec.name, re.I):
            features.append(
                _c(
                    f"README section '{sec.name}' describes features (lines {sec.detail['start_line']}-{sec.detail['end_line']}).",
                    "documentation_claim",
                    [sec.evidence_id],
                )
            )
    routes = ctx.by_kind("route")
    if routes:
        features.append(
            _c(f"{len(routes)} HTTP route(s) are declared in source (see Architecture > API routes).", "source_evidence", [r.evidence_id for r in routes[:5]])
        )
    if not features:
        features.append(_c("Key features are not determined deterministically; run the agent report for a synthesis.", "unknown"))
    users = [_c("Intended users are not determined deterministically.", "unknown")]

    overview = [
        Section(
            title="Repository",
            claims=[
                _c(f"{repo.owner}/{repo.name} at commit {snapshot.commit_sha} (branch {snapshot.default_branch or 'unknown'})", "inventory_measured"),
                _c(
                    f"{cov.get('tracked_files', 0)} tracked files; {cov.get('analyzed_files', 0)} analysed"
                    + (" (PARTIAL coverage due to limits)" if cov.get("is_partial") else ""),
                    "inventory_measured",
                ),
            ],
        ),
        Section(title="Purpose", claims=purpose),
        Section(title="Technologies", claims=tech or [_c("No technologies detected.", "unknown")]),
        Section(title="Key features", claims=features),
        Section(title="Intended users", claims=users),
    ]

    # ---------------- installation & usage ----------------
    def doc_claims(topic: str) -> list[Claim]:
        out = []
        for f in ctx.by_kind("doc_section"):
            if f.detail.get("topic") == topic:
                out.append(
                    _c(f"'{f.name}' in {f.detail['path']} (lines {f.detail['start_line']}-{f.detail['end_line']})", "documentation_claim", [f.evidence_id])
                )
        return out[:12]

    prereq: list[Claim] = []
    for meta in ctx.by_kind("project_metadata"):
        if meta.detail.get("requires-python"):
            prereq.append(_c(f"Python {meta.detail['requires-python']} ({meta.name})", "configuration_evidence", [meta.evidence_id]))
    for m in sorted({d.manifest_path for d in ctx.deps if d.manifest_path}):
        eco = next(d.ecosystem for d in ctx.deps if d.manifest_path == m)
        first = next(d for d in ctx.deps if d.manifest_path == m)
        prereq.append(_c(f"{'Node.js/npm' if eco == 'npm' else 'Python'} dependencies are declared in {m}", "configuration_evidence", [first.evidence_id]))
    prereq += doc_claims("installation")[:3]
    startup: list[Claim] = []
    for s in ctx.by_kind("script"):
        startup.append(
            _c(
                f"`{s.name}`: {s.detail.get('command')} ({s.detail.get('manifest')})",
                "configuration_evidence",
                [s.evidence_id],
                "declared script; not executed",
            )
        )
    for e in ctx.by_kind("entry_point"):
        if e.detail.get("type") in ("console_script", "container", "python_main_guard", "package_bin"):
            startup.append(_c(e.name, "source_evidence" if e.detail.get("type") == "python_main_guard" else "configuration_evidence", [e.evidence_id]))
    installation = [
        Section(title="Prerequisites", claims=prereq or [_c("No prerequisites found in manifests or documentation.", "unknown")]),
        Section(title="Installation instructions", claims=doc_claims("installation") or [_c("No installation section found in documentation.", "unknown")]),
        Section(title="Configuration", claims=doc_claims("configuration") or [_c("No configuration section found in documentation.", "unknown")]),
        Section(title="Startup commands", claims=startup[:25] or [_c("No startup commands found.", "unknown")]),
        Section(title="Example usage", claims=doc_claims("usage") or [_c("No usage section found in documentation.", "unknown")]),
        Section(
            title="Unverified assumptions",
            claims=[
                _c("Commands and instructions were extracted from documentation and manifests; none were executed by the analyzer.", "heuristic"),
            ],
        ),
    ]

    # ---------------- architecture ----------------
    source_files = [f for f in ctx.files if f.category == "source"]
    dir_counts: Counter[str] = Counter()
    dir_langs: dict[str, Counter[str]] = defaultdict(Counter)
    for f in source_files:
        top = f.path.split("/")[0] if "/" in f.path else "."
        dir_counts[top] += 1
        if f.language:
            dir_langs[top][f.language] += 1
    components = [
        _c(f"`{d}/` — {n} source file(s), mainly {', '.join(lang for lang, _ in dir_langs[d].most_common(2))}", "inventory_measured")
        for d, n in dir_counts.most_common(12)
    ]
    entry_claims = [
        _c(e.name, "source_evidence" if e.confidence == "confirmed" else "configuration_evidence", [e.evidence_id]) for e in ctx.by_kind("entry_point")
    ][:25]
    dep_claims = []
    status_text = {
        "observed_import": "imported in source",
        "not_observed": "declared; no import observed by the analyzer",
        "undeclared_import": "imported but not declared in a parsed manifest",
    }
    for d in sorted(ctx.deps, key=lambda d: (d.status != "observed_import", d.scope, d.name))[:60]:
        dep_claims.append(
            _c(
                f"{d.ecosystem}:{d.name} {d.specifier or ''} [{d.scope}] — {status_text.get(d.status, d.status)}".strip(),
                "configuration_evidence" if d.manifest_path else "source_evidence",
                [d.evidence_id],
                "not observed does not mean unused" if d.status == "not_observed" else None,
            )
        )
    route_claims = [
        _c(
            f"{r.name} → {r.detail.get('handler') or '?'} ({r.detail.get('framework')}, {r.detail.get('path')}:{r.detail.get('line')})",
            "source_evidence",
            [r.evidence_id],
            None if r.confidence == "confirmed" else "framework attribution is probable, not confirmed",
        )
        for r in routes
    ][:80]
    flows = _route_flows(session, snapshot, routes)
    rel = _directory_relationships(session, snapshot)
    architecture = [
        Section(title="Major components", claims=components or [_c("No source directories found.", "unknown")]),
        Section(title="Entry points", claims=entry_claims or [_c("No entry points detected.", "unknown")]),
        Section(title="Dependencies", claims=dep_claims or [_c("No dependency manifests parsed.", "unknown")]),
        Section(title="API routes", claims=route_claims or [_c("No HTTP routes detected by supported framework parsers.", "unknown")]),
        Section(title="Data flow", claims=flows or [_c("No route-to-implementation call chains could be resolved statically.", "unknown")]),
        Section(title="Component relationships", claims=rel or [_c("No resolved cross-directory imports.", "unknown")]),
    ]

    # ---------------- code structure ----------------
    central = summary.get("central_files", [])
    important_files = []
    for c in central[:12]:
        ev = session.scalar(
            select(GraphEdge.evidence_id).where(GraphEdge.snapshot_id == snapshot.id, GraphEdge.target_key == c["key"], GraphEdge.kind == "imports")
        )
        important_files.append(_c(f"`{c['path']}` is imported by {c['imported_by']} file(s)", "source_evidence", [ev]))
    top_syms = summary.get("most_referenced_symbols", [])
    sym_rows = {(s.path, s.qualified_name): s for s in session.scalars(select(Symbol).where(Symbol.snapshot_id == snapshot.id))}
    classes: list[Claim] = []
    functions: list[Claim] = []
    for t in top_syms:
        path, qual = t["key"][4:].split("#", 1)
        row = sym_rows.get((path, qual))
        claim = _c(f"`{qual}` ({t['kind']}) in {path} — referenced {t['references']} time(s)", "source_evidence", [row.evidence_id if row else None])
        (classes if t["kind"] == "class" else functions).append(claim)
    if not classes:
        for sym in [x for x in sym_rows.values() if x.kind == "class" and x.exported][:10]:
            classes.append(_c(f"`{sym.qualified_name}` in {sym.path}", "source_evidence", [sym.evidence_id]))
    code_structure = [
        Section(
            title="Important directories",
            claims=[_c(f"`{d}`", "inventory_measured") for d in (inv.get("source_directories") or [])[:15]] or [_c("None", "unknown")],
        ),
        Section(title="Important files", claims=important_files or [_c("No internal import hubs detected.", "unknown")]),
        Section(title="Classes", claims=classes[:15] or [_c("No classes extracted.", "unknown")]),
        Section(title="Functions", claims=functions[:15] or [_c("No cross-referenced functions resolved.", "unknown")]),
        Section(title="Module relationships", claims=rel[:10] or [_c("No resolved module relationships.", "unknown")]),
    ]

    # ---------------- engineering ----------------
    stats = summary.get("stats", {})
    test_count = sum(1 for f in ctx.files if f.category == "test")
    test_fw = [f for f in ctx.by_kind("framework") if "test" in str(f.detail.get("role"))]
    tests = [_c(f"{test_count} test file(s) identified by path conventions", "inventory_measured")]
    tests += [
        _c(f"Test framework: {f.name} ({f.confidence})", "source_evidence" if f.confidence == "observed" else "configuration_evidence", [f.evidence_id])
        for f in test_fw
    ]
    ci = ctx.by_kind("ci")
    tests += [_c(f"CI workflow: {f.name}", "configuration_evidence", [f.evidence_id]) for f in ci[:5]]
    if not ci:
        tests.append(_c("No CI configuration detected.", "inventory_measured"))
    docs_q = [
        _c(f"{len(inv.get('documentation_files', []))} documentation file(s); README {'present' if readme_secs else 'not found'}", "inventory_measured"),
        _c(
            f"Installation section {'found' if doc_claims('installation') else 'not found'}; usage section {'found' if doc_claims('usage') else 'not found'}",
            "heuristic",
        ),
    ]
    big = sorted([f for f in source_files if f.line_count], key=lambda f: -(f.line_count or 0))[:5]
    maint = [_c(f"Largest source file: `{f.path}` ({f.line_count} lines)", "inventory_measured") for f in big[:3]]
    imp_total = stats.get("imports_total", 0) or 0
    unresolved_imp = stats.get("imports_unresolved", 0)
    if imp_total:
        maint.append(_c(f"{unresolved_imp} of {imp_total} import statements look internal but could not be resolved", "heuristic"))
    if stats.get("files_with_parse_issues"):
        maint.append(_c(f"{stats['files_with_parse_issues']} file(s) had parse errors or syntax issues", "inventory_measured"))
    risks = []
    if test_count == 0:
        risks.append(_c("No test files were identified.", "heuristic"))
    if not ci:
        risks.append(_c("No continuous-integration configuration was found.", "heuristic"))
    undeclared = [d for d in ctx.deps if d.status == "undeclared_import"]
    if undeclared:
        risks.append(
            _c(
                f"{len(undeclared)} imported package(s) are not declared in a parsed manifest: " + ", ".join(d.name for d in undeclared[:10]),
                "heuristic",
                [d.evidence_id for d in undeclared[:5]],
                "may be transitive, optional or provided by the environment",
            )
        )
    limitations = _limitations(snapshot, ctx)
    engineering = [
        Section(title="Test evidence", claims=tests),
        Section(title="Documentation quality", claims=docs_q),
        Section(title="Maintainability observations", claims=maint or [_c("No observations.", "unknown")]),
        Section(title="Potential risks", claims=risks or [_c("No heuristic risks flagged.", "heuristic")]),
        Section(title="Known analysis limitations", claims=limitations),
    ]

    agent_sections = agent_sections or []
    all_sections = overview + installation + architecture + code_structure + engineering + agent_sections
    ids = sorted({i for s in all_sections for c in s.claims for i in c.evidence_ids})
    ev_rows = {e.id: e for e in session.scalars(select(Evidence).where(Evidence.snapshot_id == snapshot.id, Evidence.id.in_(ids)))} if ids else {}
    refs: list[EvidenceRef] = []
    status_count: Counter[str] = Counter()
    for i in ids:
        evrow = ev_rows.get(i)
        if evrow is None:
            status_count["missing"] += 1
            continue
        res = verify_evidence(ctx.reader, evrow)
        st = "verified" if res.ok else "invalid"
        status_count[st] += 1
        refs.append(
            EvidenceRef(
                id=evrow.id,
                path=evrow.path,
                start_line=evrow.start_line,
                end_line=evrow.end_line,
                category=evrow.category,
                source_kind=evrow.source_kind,
                verification_status=st,
                reason=res.reason,
            )
        )
    # Remove invalid evidence IDs from claims so reports never cite unverifiable locations.
    valid = {r.id for r in refs if r.verification_status == "verified"}
    for section in all_sections:
        for c in section.claims:
            c.evidence_ids = [i for i in c.evidence_ids if i in valid]

    return Report(
        kind="agent" if agent_sections else "deterministic",
        repository=f"{repo.owner}/{repo.name}",
        canonical_url=repo.canonical_url,
        commit_sha=snapshot.commit_sha,
        default_branch=snapshot.default_branch,
        generated_at=datetime.now(UTC).isoformat(),
        model=model,
        overview=overview,
        installation=installation,
        architecture=architecture,
        code_structure=code_structure,
        engineering=engineering,
        agent_narrative=agent_sections,
        coverage=cov,
        evidence=refs,
        evidence_summary={"referenced": len(ids), **status_count, "total_evidence_records": summary.get("evidence_records", 0)},
    )


def _route_flows(session: Session, snapshot: Snapshot, routes: list[Finding]) -> list[Claim]:
    out: list[Claim] = []
    edges = session.scalars(
        select(GraphEdge).where(GraphEdge.snapshot_id == snapshot.id, GraphEdge.kind.in_(["handled_by", "calls"]), GraphEdge.resolution == "resolved")
    ).all()
    calls_from: dict[str, list[GraphEdge]] = defaultdict(list)
    handled: dict[str, GraphEdge] = {}
    for e in edges:
        if e.kind == "calls":
            calls_from[e.source_key].append(e)
        else:
            handled[e.source_key] = e
    for r in routes[:20]:
        rkey = f"route:{r.name}@{r.detail.get('path')}:{r.detail.get('line')}"
        h = handled.get(rkey)
        if h is None:
            continue
        callees = [c for c in calls_from.get(h.target_key, []) if c.target_key.startswith("sym:")][:5]
        if not callees:
            continue
        names = ", ".join(c.target_key.split("#", 1)[1] for c in callees)
        out.append(_c(f"{r.name} → `{h.target_key.split('#', 1)[-1]}` → calls {names}", "source_evidence", [h.evidence_id] + [c.evidence_id for c in callees]))
    return out


def _directory_relationships(session: Session, snapshot: Snapshot) -> list[Claim]:
    edges = session.scalars(
        select(GraphEdge).where(GraphEdge.snapshot_id == snapshot.id, GraphEdge.kind == "imports", GraphEdge.resolution == "resolved")
    ).all()
    agg: Counter[tuple[str, str]] = Counter()
    sample: dict[tuple[str, str], str | None] = {}
    for e in edges:
        if not (e.source_key.startswith("file:") and e.target_key.startswith("file:")):
            continue
        a = posixpath.dirname(e.source_key[5:]) or "."
        b = posixpath.dirname(e.target_key[5:]) or "."
        if a == b:
            continue
        agg[(a, b)] += 1
        sample.setdefault((a, b), e.evidence_id)
    return [_c(f"`{a}` imports from `{b}` ({n} import edge(s))", "source_evidence", [sample[(a, b)]]) for (a, b), n in agg.most_common(15)]


def _limitations(snapshot: Snapshot, ctx: ReportContext) -> list[Claim]:
    cov = snapshot.coverage or {}
    stats = (snapshot.analysis_summary or {}).get("stats", {})
    out = []
    if cov.get("is_partial"):
        out.append(
            _c(
                f"PARTIAL coverage: {cov.get('budget_skipped_files', 0)} eligible file(s) skipped due to size/count limits; "
                f"{cov.get('tracked_files_beyond_limit', 0)} tracked file(s) beyond the inventory limit.",
                "inventory_measured",
            )
        )
    excl = cov.get("exclusions", {})
    if excl:
        out.append(_c("Excluded files by reason: " + ", ".join(f"{k}={v}" for k, v in sorted(excl.items())), "inventory_measured"))
    unsupported = Counter(f.language for f in ctx.files if f.category == "source" and f.language not in ("python", "typescript", "javascript"))
    if unsupported:
        out.append(
            _c("Source in languages without a parser (inventory only): " + ", ".join(f"{k} ({v})" for k, v in unsupported.most_common()), "inventory_measured")
        )
    if stats.get("calls_dynamic_receiver"):
        out.append(_c(f"{stats['calls_dynamic_receiver']} call sites on dynamic receivers (e.g. obj.method()) were not resolved.", "inventory_measured"))
    out.append(
        _c(
            "Call resolution is name-based within a file and through imports; inheritance, dynamic dispatch, "
            "decorators' runtime effects and reflection are not modelled.",
            "heuristic",
        )
    )
    out.append(_c("Nothing in the repository was executed; runtime behaviour is not observed.", "heuristic"))
    return out


def build_deterministic_report(session: Session, snapshot: Snapshot) -> ReportRow:
    model = build_report_model(session, snapshot)
    return save_report(session, snapshot, model, kind="deterministic")


def save_report(session: Session, snapshot: Snapshot, model: Report, kind: str, usage: dict[str, Any] | None = None, status: str = "complete") -> ReportRow:
    row = ReportRow(
        snapshot_id=snapshot.id,
        kind=kind,
        status=status,
        model=model.model,
        content=model.model_dump(mode="json"),
        markdown=render_markdown(model),
        usage=usage or {},
    )
    session.add(row)
    session.commit()
    return row
