"""SQLite FTS5 full-text index over analysed file contents."""

from __future__ import annotations

import re

from sqlalchemy import text
from sqlalchemy.orm import Session

_TOKEN = re.compile(r"[A-Za-z0-9_]{2,64}")


def index_files(session: Session, snapshot_id: int, contents: dict[str, str]) -> int:
    session.execute(text("DELETE FROM file_fts WHERE snapshot_id = :s"), {"s": snapshot_id})
    rows = [{"s": snapshot_id, "p": p, "c": c} for p, c in contents.items()]
    if rows:
        session.execute(text("INSERT INTO file_fts (snapshot_id, path, content) VALUES (:s, :p, :c)"), rows)
    return len(rows)


def build_match_query(query: str) -> str | None:
    """Turn free text into a safe FTS5 query of quoted tokens (no operator injection)."""
    tokens = _TOKEN.findall(query)[:12]
    if not tokens:
        return None
    return " ".join(f'"{t}"' for t in tokens)


def search(session: Session, snapshot_id: int, query: str, limit: int = 20) -> list[dict]:
    match = build_match_query(query)
    if match is None:
        return []
    rows = session.execute(
        text(
            "SELECT path, snippet(file_fts, 2, '[', ']', ' … ', 12) AS snip, bm25(file_fts) AS score "
            "FROM file_fts WHERE file_fts MATCH :q AND snapshot_id = :s ORDER BY score LIMIT :l"
        ),
        {"q": match, "s": snapshot_id, "l": max(1, min(limit, 50))},
    ).all()
    return [{"path": r.path, "snippet": r.snip, "score": float(r.score)} for r in rows]


def matching_lines(lines: list[str], query: str, max_hits: int = 5) -> list[int]:
    tokens = [t.lower() for t in _TOKEN.findall(query)[:12]]
    hits = []
    for i, line in enumerate(lines, 1):
        low = line.lower()
        if tokens and all(t in low for t in tokens):
            hits.append(i)
            if len(hits) >= max_hits:
                break
    if not hits:
        for i, line in enumerate(lines, 1):
            low = line.lower()
            if any(t in low for t in tokens):
                hits.append(i)
                if len(hits) >= max_hits:
                    break
    return hits
