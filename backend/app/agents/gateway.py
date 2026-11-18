"""Read-only tool gateway exposed to the agent.

The model never receives tool access inside OpenCode. Instead it may *request* one of
these operations in its structured output; the backend validates the request and
executes it against the persisted snapshot. Properties enforced in code:

  * read-only: no writes to the snapshot, no process execution, no network;
  * scoped: only files that were analysed in *this* snapshot are readable, paths are
    validated (no traversal, no symlinks, must stay inside the snapshot root);
  * bounded: per-request line limits and a total byte/request budget.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.database.models import Evidence, FileRecord, GraphEdge, Snapshot, Symbol
from app.evidence.collector import EvidenceCollector
from app.evidence.contract import CATEGORY_TO_SOURCE_KIND, EvidenceCategory, ExtractionMethod, SourceKind
from app.evidence.verifier import SnapshotReader
from app.search.fts import matching_lines, search

MAX_LINES_PER_READ = 120


class ReadFileRange(BaseModel):
    tool: Literal["read_file_range"]
    path: str = Field(max_length=1000)
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)


class SearchCode(BaseModel):
    tool: Literal["search"]
    query: str = Field(min_length=2, max_length=200)


class GetSymbol(BaseModel):
    tool: Literal["get_symbol"]
    name: str = Field(min_length=1, max_length=300)


class ListDirectory(BaseModel):
    tool: Literal["list_directory"]
    path: str = Field(default="", max_length=1000)


class GraphNeighbors(BaseModel):
    tool: Literal["graph_neighbors"]
    node_key: str = Field(max_length=1200)


ToolRequest = Annotated[ReadFileRange | SearchCode | GetSymbol | ListDirectory | GraphNeighbors, Field(discriminator="tool")]


class GatewayBudget(BaseModel):
    max_requests: int = 24
    max_bytes: int = 120_000


class ReadOnlyGateway:
    def __init__(self, session: Session, snapshot: Snapshot, budget: GatewayBudget | None = None) -> None:
        self.session = session
        self.snapshot = snapshot
        self.reader = SnapshotReader(session, snapshot)
        self.budget = budget or GatewayBudget()
        self.requests_used = 0
        self.bytes_used = 0
        self.log: list[dict] = []

    def _register(self, path: str, start: int, end: int, subject: str) -> str | None:
        rec = self.reader.readable(path)
        lines = self.reader.lines(path)
        if rec is None or lines is None:
            return None
        kind = CATEGORY_TO_SOURCE_KIND.get(rec.category, SourceKind.SOURCE)
        col = EvidenceCollector(self.snapshot.id, self.snapshot.repository_id, self.snapshot.commit_sha, {path: lines}, {path: kind})
        eid = col.add(path, start, end, EvidenceCategory.RETRIEVED_SOURCE, ExtractionMethod.GATEWAY_READ, subject)
        if eid is None:
            return None
        if self.session.get(Evidence, eid) is None:
            self.session.add(Evidence(**col.records[eid]))
            self.session.flush()
        return eid

    def execute(self, req: ReadFileRange | SearchCode | GetSymbol | ListDirectory | GraphNeighbors) -> dict:
        if self.requests_used >= self.budget.max_requests:
            return {"tool": req.tool, "error": "request budget exhausted"}
        if self.bytes_used >= self.budget.max_bytes:
            return {"tool": req.tool, "error": "byte budget exhausted"}
        self.requests_used += 1
        if isinstance(req, ReadFileRange):
            result = self._read(req)
        elif isinstance(req, SearchCode):
            result = self._search(req)
        elif isinstance(req, GetSymbol):
            result = self._symbol(req)
        elif isinstance(req, ListDirectory):
            result = self._list(req)
        else:
            result = self._neighbors(req)
        size = len(str(result))
        self.bytes_used += size
        self.log.append({"tool": req.tool, "args": req.model_dump(exclude={"tool"}), "bytes": size, "error": result.get("error")})
        return result

    def _read(self, req: ReadFileRange) -> dict:
        path = req.path.strip().removeprefix("./")
        lines = self.reader.lines(path) if self.reader.readable(path) else None
        if lines is None:
            return {"tool": "read_file_range", "path": path, "error": "path is not an analysed file of this snapshot"}
        n = max(len(lines), 1)
        start = min(req.start_line, n)
        end = min(max(req.end_line, start), n, start + MAX_LINES_PER_READ - 1)
        eid = self._register(path, start, end, f"read {path}:{start}-{end}")
        text = "\n".join(f"{i}: {lines[i - 1]}" for i in range(start, end + 1)) if lines else ""
        return {"tool": "read_file_range", "evidence_id": eid, "path": path, "start_line": start, "end_line": end, "total_lines": n, "content": text}

    def _search(self, req: SearchCode) -> dict:
        hits = []
        for r in search(self.session, self.snapshot.id, req.query, limit=8):
            lines = self.reader.lines(r["path"]) or []
            for ln in matching_lines(lines, req.query, max_hits=2):
                s, e = max(1, ln - 2), min(len(lines), ln + 2)
                eid = self._register(r["path"], s, e, f"search {req.query}")
                hits.append(
                    {
                        "evidence_id": eid,
                        "path": r["path"],
                        "start_line": s,
                        "end_line": e,
                        "content": "\n".join(f"{i}: {lines[i - 1]}" for i in range(s, e + 1)),
                    }
                )
        return {"tool": "search", "query": req.query, "hits": hits[:12]}

    def _symbol(self, req: GetSymbol) -> dict:
        rows = self.session.scalars(
            select(Symbol).where(Symbol.snapshot_id == self.snapshot.id, or_(Symbol.name == req.name, Symbol.qualified_name == req.name)).limit(10)
        ).all()
        return {
            "tool": "get_symbol",
            "name": req.name,
            "matches": [
                {
                    "evidence_id": s.evidence_id,
                    "kind": s.kind,
                    "qualified_name": s.qualified_name,
                    "path": s.path,
                    "start_line": s.start_line,
                    "end_line": s.end_line,
                    "signature": s.signature,
                    "docstring": s.docstring,
                }
                for s in rows
            ],
        }

    def _list(self, req: ListDirectory) -> dict:
        prefix = req.path.strip().strip("/")
        rows = self.session.scalars(select(FileRecord).where(FileRecord.snapshot_id == self.snapshot.id)).all()
        entries: dict[str, str] = {}
        for f in rows:
            if prefix and not f.path.startswith(prefix + "/"):
                continue
            rest = f.path[len(prefix) + 1 :] if prefix else f.path
            head = rest.split("/")[0]
            entries[head] = "dir" if "/" in rest else f"file ({f.category}{', analysed' if f.analyzed else ''})"
        return {"tool": "list_directory", "path": prefix, "entries": dict(sorted(entries.items())[:200])}

    def _neighbors(self, req: GraphNeighbors) -> dict:
        edges = self.session.scalars(
            select(GraphEdge)
            .where(GraphEdge.snapshot_id == self.snapshot.id, or_(GraphEdge.source_key == req.node_key, GraphEdge.target_key == req.node_key))
            .limit(60)
        ).all()
        return {
            "tool": "graph_neighbors",
            "node_key": req.node_key,
            "edges": [
                {"source": e.source_key, "target": e.target_key, "kind": e.kind, "resolution": e.resolution, "evidence_id": e.evidence_id} for e in edges
            ],
        }
