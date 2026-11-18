"""Compare two analysed snapshots of the same repository. Every difference comes from persisted rows."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import ValidationFailed
from app.database.models import Dependency, FileRecord, Finding, GraphEdge, Snapshot, Symbol
from app.graph.queries import load_index

SAMPLE = 200


def compare_snapshots(session: Session, base: Snapshot, head: Snapshot) -> dict[str, Any]:
    if base.repository_id != head.repository_id:
        raise ValidationFailed("Snapshots belong to different repositories")
    if base.status != "ready" or head.status != "ready":
        raise ValidationFailed("Both snapshots must be ready")

    def files(s: Snapshot) -> dict[str, FileRecord]:
        return {f.path: f for f in session.scalars(select(FileRecord).where(FileRecord.snapshot_id == s.id))}

    bf, hf = files(base), files(head)
    added = sorted(set(hf) - set(bf))
    removed = sorted(set(bf) - set(hf))
    modified = []
    for p in sorted(set(bf) & set(hf)):
        a, b = bf[p], hf[p]
        if (a.sha256 and b.sha256 and a.sha256 != b.sha256) or (not (a.sha256 and b.sha256) and a.size != b.size):
            modified.append(
                {
                    "path": p,
                    "size_before": a.size,
                    "size_after": b.size,
                    "lines_before": a.line_count,
                    "lines_after": b.line_count,
                    "content_compared": bool(a.sha256 and b.sha256),
                }
            )

    def symbols(s: Snapshot) -> dict[tuple[str, str, str], Symbol]:
        return {(x.path, x.qualified_name, x.kind): x for x in session.scalars(select(Symbol).where(Symbol.snapshot_id == s.id))}

    bs, hs = symbols(base), symbols(head)
    sym_added = [_sym(hs[k]) for k in sorted(set(hs) - set(bs))]
    sym_removed = [_sym(bs[k]) for k in sorted(set(bs) - set(hs))]
    sig_changed = [
        {**_sym(hs[k]), "signature_before": bs[k].signature, "signature_after": hs[k].signature}
        for k in sorted(set(bs) & set(hs))
        if (bs[k].signature or "") != (hs[k].signature or "")
    ]

    def deps(s: Snapshot) -> dict[tuple[str, str, str], Dependency]:
        return {(d.ecosystem, d.name, d.scope): d for d in session.scalars(select(Dependency).where(Dependency.snapshot_id == s.id))}

    bd, hd = deps(base), deps(head)
    dep_changes = {
        "added": [_dep(hd[k]) for k in sorted(set(hd) - set(bd))],
        "removed": [_dep(bd[k]) for k in sorted(set(bd) - set(hd))],
        "changed": [
            {**_dep(hd[k]), "specifier_before": bd[k].specifier, "status_before": bd[k].status}
            for k in sorted(set(bd) & set(hd))
            if (bd[k].specifier, bd[k].status) != (hd[k].specifier, hd[k].status)
        ],
    }

    def routes(s: Snapshot) -> dict[str, Finding]:
        return {
            f"{f.name}@{(f.detail or {}).get('path')}": f for f in session.scalars(select(Finding).where(Finding.snapshot_id == s.id, Finding.kind == "route"))
        }

    br, hr = routes(base), routes(head)

    def edges(s: Snapshot) -> set[tuple[str, str, str, str]]:
        return {
            (e.source_key, e.target_key, e.kind, e.resolution)
            for e in session.scalars(select(GraphEdge).where(GraphEdge.snapshot_id == s.id, GraphEdge.kind.in_(["imports", "calls", "inherits", "handled_by"])))
        }

    be, he = edges(base), edges(head)
    e_added = sorted(he - be)
    e_removed = sorted(be - he)

    # Potential impact: dependents (in head) of symbols defined in modified/added files.
    idx = load_index(session, head)
    changed_paths = {m["path"] for m in modified} | set(added)
    impacted: dict[str, dict[str, Any]] = {}
    for key, node in idx.nodes.items():
        if node.path in changed_paths and node.kind in ("function", "method", "class", "file"):
            for e in idx.inc.get(key, []):
                if e.kind in ("calls", "imports", "inherits", "handled_by") and e.resolution in ("resolved", "ambiguous"):
                    src = idx.nodes.get(e.source)
                    if src is not None and src.path not in changed_paths:
                        impacted.setdefault(e.source, {**idx.node_info(e.source), "because_of": key, "evidence_id": e.evidence_id})
    return {
        "base": _snap(base),
        "head": _snap(head),
        "files": {
            "added": added[:SAMPLE],
            "removed": removed[:SAMPLE],
            "modified": modified[:SAMPLE],
            "counts": {"added": len(added), "removed": len(removed), "modified": len(modified), "unchanged": len(set(bf) & set(hf)) - len(modified)},
        },
        "symbols": {
            "added": sym_added[:SAMPLE],
            "removed": sym_removed[:SAMPLE],
            "signature_changed": sig_changed[:SAMPLE],
            "counts": {"added": len(sym_added), "removed": len(sym_removed), "signature_changed": len(sig_changed)},
        },
        "dependencies": dep_changes,
        "routes": {"added": [_route(hr[k]) for k in sorted(set(hr) - set(br))], "removed": [_route(br[k]) for k in sorted(set(br) - set(hr))]},
        "graph": {
            "edges_added": [_edge(e) for e in e_added[:SAMPLE]],
            "edges_removed": [_edge(e) for e in e_removed[:SAMPLE]],
            "counts": {"added": len(e_added), "removed": len(e_removed)},
        },
        "potential_impact": {
            "unchanged_dependents_of_changed_code": list(impacted.values())[:SAMPLE],
            "count": len(impacted),
            "note": "Code outside the changed files that statically references changed or added code. Potential, not confirmed, impact.",
        },
        "limitations": [
            "Files outside the analysed coverage of either snapshot are compared by size only.",
            "Symbol identity is (path, qualified name, kind); a moved or renamed symbol appears as removed + added.",
            "Differences in analyzer version between snapshots can produce graph differences unrelated to code changes."
            if base.analyzer_version != head.analyzer_version
            else "Both snapshots were produced by the same analyzer version.",
        ],
    }


def _snap(s: Snapshot) -> dict[str, Any]:
    return {"id": s.id, "commit_sha": s.commit_sha, "analyzer_version": s.analyzer_version, "acquired_at": s.acquired_at.isoformat()}


def _sym(s: Symbol) -> dict[str, Any]:
    return {
        "path": s.path,
        "qualified_name": s.qualified_name,
        "kind": s.kind,
        "start_line": s.start_line,
        "end_line": s.end_line,
        "evidence_id": s.evidence_id,
    }


def _dep(d: Dependency) -> dict[str, Any]:
    return {"ecosystem": d.ecosystem, "name": d.name, "specifier": d.specifier, "scope": d.scope, "status": d.status, "evidence_id": d.evidence_id}


def _route(f: Finding) -> dict[str, Any]:
    return {"name": f.name, "path": (f.detail or {}).get("path"), "handler": (f.detail or {}).get("handler"), "evidence_id": f.evidence_id}


def _edge(e: tuple[str, str, str, str]) -> dict[str, str]:
    return {"source": e[0], "target": e[1], "kind": e[2], "resolution": e[3]}
