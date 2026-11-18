"""Deterministic hybrid retrieval: symbols, file paths, FTS5 content and graph neighbourhood.

No embeddings. Each result carries the signals that produced its score so ranking is explainable.
"""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.database.models import Evidence, FileRecord, Snapshot, Symbol
from app.evidence.verifier import SnapshotReader
from app.graph.queries import GraphIndex
from app.search.fts import matching_lines, search

_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]{1,63}")
_STOP = {
    "the",
    "and",
    "for",
    "what",
    "where",
    "when",
    "how",
    "does",
    "this",
    "that",
    "with",
    "from",
    "into",
    "are",
    "is",
    "which",
    "who",
    "why",
    "happens",
    "explain",
    "show",
    "called",
    "used",
    "user",
    "code",
    "file",
    "files",
    "function",
    "class",
    "module",
    "would",
    "affected",
    "changes",
    "change",
    "depends",
    "depend",
    "interact",
    "flow",
    "work",
    "works",
    "about",
    "use",
    "uses",
    "a",
    "an",
    "of",
    "to",
    "in",
    "on",
    "if",
}
_DOTTED = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+")
WEIGHTS = {
    "qualified_exact": 16.0,
    "symbol_exact": 10.0,
    "symbol_prefix": 6.0,
    "symbol_contains": 3.0,
    "path": 4.0,
    "fts": 3.0,
    "graph_neighbour": 1.5,
    "centrality": 0.5,
}


def tokens(query: str) -> list[str]:
    out = []
    for w in _WORD.findall(query):
        # split camelCase / snake_case for matching but keep the original too
        parts = [w, *re.findall(r"[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])", w)]
        for p in parts:
            pl = p.lower()
            if len(pl) >= 3 and pl not in _STOP and pl not in out:
                out.append(pl)
    return out[:12]


def retrieve(session: Session, snapshot: Snapshot, idx: GraphIndex, query: str, limit: int = 15, categories: set[str] | None = None) -> dict[str, Any]:
    toks = tokens(query)
    raw_words = [w for w in _WORD.findall(query) if len(w) >= 3 and w.lower() not in _STOP]
    # "Signer.get_signature" names one symbol exactly; it must outrank symbols matching only one part.
    dotted = {d.lower() for d in _DOTTED.findall(query)}
    scores: dict[str, float] = defaultdict(float)
    signals: dict[str, list[str]] = defaultdict(list)
    items: dict[str, dict[str, Any]] = {}

    # 1. symbols
    if toks:
        conds = [func.lower(Symbol.name).contains(t) for t in toks] + [func.lower(Symbol.qualified_name).contains(t) for t in toks]
        for s in session.scalars(select(Symbol).where(Symbol.snapshot_id == snapshot.id, or_(*conds)).limit(400)):
            key = f"sym:{s.path}#{s.qualified_name}"
            name = s.name.lower()
            best = 0.0
            sig = ""
            qn = s.qualified_name.lower()
            if any(qn == d or qn.endswith("." + d) for d in dotted):
                best, sig = WEIGHTS["qualified_exact"], "qualified_exact"
            for w in raw_words:
                wl = w.lower()
                if name == wl or s.qualified_name.lower() == wl:
                    best, sig = max((best, sig), (WEIGHTS["symbol_exact"], "symbol_exact"))
                elif name.startswith(wl):
                    best, sig = max((best, sig), (WEIGHTS["symbol_prefix"], "symbol_prefix"))
            for t in toks:
                if t in name and best < WEIGHTS["symbol_contains"]:
                    best, sig = WEIGHTS["symbol_contains"], "symbol_contains"
            if best:
                scores[key] += best
                signals[key].append(sig)
                items[key] = {
                    "kind": "symbol",
                    "key": key,
                    "label": s.qualified_name,
                    "symbol_kind": s.kind,
                    "path": s.path,
                    "start_line": s.start_line,
                    "end_line": s.end_line,
                    "evidence_id": s.evidence_id,
                    "signature": s.signature,
                }

    # 2. file paths
    if toks:
        for f in session.scalars(
            select(FileRecord)
            .where(FileRecord.snapshot_id == snapshot.id, FileRecord.analyzed.is_(True), or_(*[func.lower(FileRecord.path).contains(t) for t in toks]))
            .limit(200)
        ):
            key = f"file:{f.path}"
            hits = sum(1 for t in toks if t in f.path.lower())
            scores[key] += WEIGHTS["path"] * hits
            signals[key].append("path")
            items.setdefault(
                key,
                {
                    "kind": "file",
                    "key": key,
                    "label": f.path,
                    "path": f.path,
                    "start_line": 1,
                    "end_line": min(f.line_count or 1, 40),
                    "category": f.category,
                    "evidence_id": None,
                },
            )

    # 3. full-text content
    reader = SnapshotReader(session, snapshot)
    for rank, r in enumerate(search(session, snapshot.id, " ".join(toks) or query, limit=20)):
        lines = reader.lines(r["path"]) or []
        hit_lines = matching_lines(lines, " ".join(toks) or query, max_hits=1)
        ln = hit_lines[0] if hit_lines else 1
        key = f"text:{r['path']}:{ln}"
        scores[key] += WEIGHTS["fts"] * (1.0 - rank / 25)
        signals[key].append("fts")
        items[key] = {
            "kind": "text",
            "key": key,
            "label": f"{r['path']}:{ln}",
            "path": r["path"],
            "start_line": max(1, ln - 3),
            "end_line": min(len(lines) or 1, ln + 3),
            "snippet": r["snippet"],
            "evidence_id": None,
        }

    # 4. graph neighbourhood boost: neighbours of top symbol hits
    top_symbols = sorted((k for k in scores if k.startswith("sym:")), key=lambda k: -scores[k])[:5]
    for k in top_symbols:
        for e in idx.out.get(k, [])[:20] + idx.inc.get(k, [])[:20]:
            other = e.target if e.source == k else e.source
            if other.startswith("sym:") and other in idx.nodes and other not in top_symbols:
                scores[other] += WEIGHTS["graph_neighbour"]
                signals[other].append(f"neighbour_of:{k.split('#', 1)[-1]}")
                n = idx.nodes[other]
                items.setdefault(
                    other,
                    {
                        "kind": "symbol",
                        "key": other,
                        "label": n.label,
                        "symbol_kind": n.kind,
                        "path": n.path,
                        "start_line": n.start_line,
                        "end_line": n.end_line,
                        "evidence_id": None,
                    },
                )
    # centrality: in-degree of resolved references
    for k in list(scores):
        if k.startswith("sym:"):
            indeg = sum(1 for e in idx.inc.get(k, []) if e.kind in ("calls", "inherits") and e.resolution == "resolved")
            if indeg:
                scores[k] += WEIGHTS["centrality"] * min(indeg, 10) / 10
    if categories:
        keep = {"symbol": "symbol" in categories, "file": "file" in categories, "text": "text" in categories}
        for k in list(scores):
            if not keep.get(items[k]["kind"], True):
                del scores[k]
    ranked = sorted(scores, key=lambda k: (-scores[k], k))[:limit]
    # attach definition evidence for symbols lacking it
    missing = [items[k]["key"] for k in ranked if items[k]["kind"] == "symbol" and not items[k].get("evidence_id")]
    if missing:
        for s in session.scalars(select(Symbol).where(Symbol.snapshot_id == snapshot.id)):
            k = f"sym:{s.path}#{s.qualified_name}"
            if k in missing:
                items[k]["evidence_id"] = s.evidence_id
    results = [{**items[k], "score": round(scores[k], 3), "signals": signals[k]} for k in ranked]
    return {"query": query, "tokens": toks, "results": results, "weights": WEIGHTS}


def evidence_count(session: Session, snapshot_id: int) -> int:
    return session.scalar(select(func.count()).select_from(Evidence).where(Evidence.snapshot_id == snapshot_id)) or 0
