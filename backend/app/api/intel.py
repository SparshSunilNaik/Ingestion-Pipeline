"""M3-M5 endpoints: auth, refresh, code tree, usage, flows, retrieval, graph views, compare, Q&A."""

from __future__ import annotations

import posixpath
from collections import Counter, defaultdict
from typing import Any

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agents.service import selected_model
from app.api.routes import _snapshot, require_auth, runtime_dep, settings_dep
from app.core.auth import COOKIE, Unauthorized
from app.core.config import Settings
from app.core.errors import AgentUnavailable, Conflict, NotFound, ValidationFailed
from app.database.engine import get_db
from app.database.models import Conversation, FileRecord, Job, Message, Repository
from app.graph.compare import compare_snapshots
from app.graph.queries import entry_points, load_index, trace_flow, usage
from app.ingestion import jobs as jobstore
from app.schemas.api import JobCreatedOut, JobOut
from app.search.hybrid import retrieve

public = APIRouter(prefix="/api")
router = APIRouter(prefix="/api", dependencies=[Depends(require_auth)])


# ---------------------------------------------------------------- auth
class LoginIn(BaseModel):
    token: str = Field(min_length=1, max_length=512)


@public.get("/auth/status", tags=["auth"])
def auth_status(request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    auth = request.app.state.auth
    try:
        method = auth.authenticate(request, db) if request.method == "GET" else None
        ok = True
    except Exception:
        method, ok = None, False
    return {
        "auth_mode": "token" if auth.enabled else "disabled",
        "authenticated": ok,
        "method": method,
        "token_hint": "Token file: <backend data dir>/api-token (readable only by your Windows user)" if auth.enabled else None,
    }


@public.post("/auth/login", tags=["auth"])
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)) -> dict[str, Any]:
    auth = request.app.state.auth
    if not auth.enabled:
        return {"authenticated": True, "auth_mode": "disabled"}
    client = request.client.host if request.client else "unknown"
    auth.limiter.check(client)
    if not auth.token_ok(body.token.strip()):
        auth.limiter.fail(client)
        raise Unauthorized("Invalid API token")
    secret, expires = auth.create_session(db)
    response.set_cookie(COOKIE, secret, httponly=True, samesite="strict", secure=False, path="/", max_age=int(auth.settings.session_ttl_hours * 3600))
    return {"authenticated": True, "expires_at": expires.isoformat()}


@public.post("/auth/logout", tags=["auth"])
def logout(request: Request, response: Response, db: Session = Depends(get_db)) -> dict[str, Any]:
    request.app.state.auth.drop_session(db, request.cookies.get(COOKIE))
    response.delete_cookie(COOKIE, path="/")
    return {"authenticated": False}


# ---------------------------------------------------------------- repositories
@router.post("/repositories/{repo_id}/refresh", response_model=JobCreatedOut, status_code=202, tags=["ingestion"])
def refresh_repository(repo_id: int, response: Response, db: Session = Depends(get_db)) -> JobCreatedOut:
    repo = db.get(Repository, repo_id)
    if repo is None:
        raise NotFound("repository not found")
    job, created = jobstore.create_ingest_job(db, repo.canonical_url)
    db.commit()
    if not created:
        response.status_code = 200
    return JobCreatedOut(job=JobOut.model_validate(job), created=created)


@router.get("/snapshots/{snapshot_id}/tree", tags=["snapshots"])
def file_tree(snapshot_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Compact list of every inventoried file (for the code explorer tree)."""
    _snapshot(db, snapshot_id)
    rows = db.execute(
        select(
            FileRecord.path, FileRecord.category, FileRecord.language, FileRecord.analyzed, FileRecord.size, FileRecord.line_count, FileRecord.exclusion_reason
        )
        .where(FileRecord.snapshot_id == snapshot_id)
        .order_by(FileRecord.path)
    ).all()
    return {"files": [{"p": r.path, "c": r.category, "l": r.language, "a": r.analyzed, "s": r.size, "n": r.line_count, "x": r.exclusion_reason} for r in rows]}


# ---------------------------------------------------------------- intelligence
@router.get("/snapshots/{snapshot_id}/usage", tags=["intelligence"])
def symbol_usage(snapshot_id: int, key: str = Query(max_length=1200), depth: int = Query(3, ge=1, le=6), db: Session = Depends(get_db)) -> dict[str, Any]:
    snap = _snapshot(db, snapshot_id)
    res = usage(db, load_index(db, snap), key, depth)
    if "error" in res:
        raise NotFound("graph node not found")
    return res


@router.get("/snapshots/{snapshot_id}/flows/entry-points", tags=["intelligence"])
def flow_entry_points(snapshot_id: int, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    snap = _snapshot(db, snapshot_id)
    return entry_points(db, snap, load_index(db, snap))


@router.get("/snapshots/{snapshot_id}/flows/trace", tags=["intelligence"])
def flow_trace(
    snapshot_id: int,
    key: str = Query(max_length=1200),
    depth: int = Query(5, ge=1, le=10),
    max_steps: int = Query(120, ge=5, le=500),
    line_start: int | None = None,
    line_end: int | None = None,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    snap = _snapshot(db, snapshot_id)
    idx = load_index(db, snap)
    if key not in idx.nodes:
        raise NotFound("graph node not found")
    return trace_flow(idx, key, depth, max_steps, [line_start, line_end] if line_start else None)


@router.get("/snapshots/{snapshot_id}/retrieve", tags=["intelligence"])
def hybrid_retrieve(
    snapshot_id: int,
    q: str = Query(min_length=2, max_length=300),
    limit: int = Query(15, ge=1, le=50),
    categories: str | None = Query(None, max_length=64),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    snap = _snapshot(db, snapshot_id)
    cats = {c.strip() for c in categories.split(",")} if categories else None
    return retrieve(db, snap, load_index(db, snap), q, limit, cats)


@router.get("/snapshots/{snapshot_id}/graph/view", tags=["graph"])
def graph_view(
    snapshot_id: int,
    view: str = Query("modules", pattern="^(modules|files|calls|routes|focus)$"),
    focus: str | None = Query(None, max_length=1200),
    radius: int = Query(1, ge=1, le=3),
    path_prefix: str | None = Query(None, max_length=500),
    limit: int = Query(250, ge=10, le=1500),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Graph projections designed to stay readable: directory modules, files, call graph, route graph, focus subgraph."""
    snap = _snapshot(db, snapshot_id)
    idx = load_index(db, snap)
    nodes: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []

    def add_node(key: str, **extra: Any) -> None:
        if key not in nodes:
            nodes[key] = {**idx.node_info(key), **extra}

    if view == "modules":
        count: Counter[str] = Counter()
        langs: dict[str, Counter[str]] = defaultdict(Counter)
        for n in idx.nodes.values():
            if n.kind == "file" and n.path and (not path_prefix or n.path.startswith(path_prefix)):
                d = posixpath.dirname(n.path) or "."
                count[d] += 1
                langs[d][str((n.attrs or {}).get("language") or "")] += 1
        agg: Counter[tuple[str, str]] = Counter()
        sample: dict[tuple[str, str], str | None] = {}
        for k in idx.nodes:
            if not k.startswith("file:"):
                continue
            for e in idx.out.get(k, []):
                if e.kind == "imports" and e.resolution == "resolved" and e.target.startswith("file:"):
                    a = posixpath.dirname(k[5:]) or "."
                    b = posixpath.dirname(e.target[5:]) or "."
                    if a != b and a in count and b in count:
                        agg[(a, b)] += 1
                        sample.setdefault((a, b), e.evidence_id)
        for d, c in count.most_common(limit):
            nodes[f"dir:{d}"] = {
                "key": f"dir:{d}",
                "kind": "module",
                "label": d,
                "path": d,
                "start_line": None,
                "end_line": None,
                "files": c,
                "languages": dict(langs[d]),
            }
        for (a, b), c in agg.items():
            if f"dir:{a}" in nodes and f"dir:{b}" in nodes:
                edges.append(
                    {"source": f"dir:{a}", "target": f"dir:{b}", "kind": "imports", "resolution": "resolved", "count": c, "evidence_id": sample[(a, b)]}
                )
    else:
        wanted_edges = {
            "files": ("imports", "declares_route"),
            "calls": ("calls", "inherits", "handled_by"),
            "routes": ("handled_by", "calls", "declares_route"),
            "focus": ("imports", "calls", "inherits", "handled_by", "declares_route", "contains"),
        }[view]
        if view == "focus":
            if not focus or focus not in idx.nodes:
                raise ValidationFailed("focus view needs an existing node key")
            frontier = {focus}
            add_node(focus, focus=True)
            for _ in range(radius):
                nxt: set[str] = set()
                for k in frontier:
                    for e in idx.out.get(k, []) + idx.inc.get(k, []):
                        if e.kind in wanted_edges:
                            other = e.target if e.source == k else e.source
                            if other not in nodes and len(nodes) < limit:
                                add_node(other)
                                nxt.add(other)
                frontier = nxt
        elif view == "routes":
            for k, n in idx.nodes.items():
                if n.kind == "route":
                    add_node(k)
            # handlers and their direct callees (2 hops)
            for k in list(nodes):
                for e in idx.out.get(k, []):
                    if e.kind == "handled_by":
                        add_node(e.target)
                        for e2 in idx.out.get(e.target, []):
                            if e2.kind == "calls" and len(nodes) < limit:
                                add_node(e2.target)
        else:
            kinds = {"files": {"file", "package", "route"}, "calls": {"function", "method", "class", "route"}}[view]
            degree: Counter[str] = Counter()
            for k, n in idx.nodes.items():
                if n.kind in kinds and (not path_prefix or (n.path or "").startswith(path_prefix) or n.kind == "package"):
                    for e in idx.out.get(k, []):
                        if e.kind in wanted_edges:
                            degree[k] += 1
                            degree[e.target] += 1
            for k, _ in degree.most_common(limit):
                if k in idx.nodes and idx.nodes[k].kind in kinds | ({"unresolved"} if view == "calls" else set()):
                    add_node(k)
        for k in list(nodes):
            for e in idx.out.get(k, []):
                if e.kind in wanted_edges and e.target in nodes:
                    edges.append(
                        {
                            "source": k,
                            "target": e.target,
                            "kind": e.kind,
                            "resolution": e.resolution,
                            "count": int(e.attrs.get("count", 1)),
                            "evidence_id": e.evidence_id,
                            "via": e.attrs.get("via"),
                        }
                    )
    # mark entry points / routes for styling
    route_handlers = {e.target for k, n in idx.nodes.items() if n.kind == "route" for e in idx.out.get(k, []) if e.kind == "handled_by"}
    for k, info in nodes.items():
        info["is_route_handler"] = k in route_handlers
    return {"view": view, "nodes": list(nodes.values()), "edges": edges, "truncated": len(nodes) >= limit}


@router.get("/compare", tags=["intelligence"])
def compare(base: int, head: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    return compare_snapshots(db, _snapshot(db, base), _snapshot(db, head))


# ---------------------------------------------------------------- Q&A
class ConversationIn(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    model: str | None = Field(default=None, max_length=200)


class QuestionIn(BaseModel):
    content: str = Field(min_length=2, max_length=2000)


def _conversation_out(db: Session, c: Conversation, with_messages: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"id": c.id, "snapshot_id": c.snapshot_id, "title": c.title, "model": c.model, "created_at": c.created_at, "updated_at": c.updated_at}
    if with_messages:
        msgs = db.scalars(select(Message).where(Message.conversation_id == c.id).order_by(Message.id)).all()
        out["messages"] = [
            {"id": m.id, "role": m.role, "content": m.content, "status": m.status, "job_id": m.job_id, "payload": m.payload, "created_at": m.created_at}
            for m in msgs
        ]
    return out


@router.post("/snapshots/{snapshot_id}/conversations", status_code=201, tags=["qa"])
def create_conversation(snapshot_id: int, body: ConversationIn, db: Session = Depends(get_db), settings: Settings = Depends(settings_dep)) -> dict[str, Any]:
    snap = _snapshot(db, snapshot_id)
    if snap.status != "ready":
        raise Conflict("snapshot is not ready")
    model = body.model or selected_model(db, settings)
    c = Conversation(snapshot_id=snap.id, title=(body.title or "New investigation")[:200], model=model)
    db.add(c)
    db.commit()
    return _conversation_out(db, c)


@router.get("/snapshots/{snapshot_id}/conversations", tags=["qa"])
def list_conversations(snapshot_id: int, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    _snapshot(db, snapshot_id)
    return [
        _conversation_out(db, c)
        for c in db.scalars(select(Conversation).where(Conversation.snapshot_id == snapshot_id).order_by(Conversation.updated_at.desc()))
    ]


@router.get("/conversations/{conversation_id}", tags=["qa"])
def get_conversation(conversation_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    c = db.get(Conversation, conversation_id)
    if c is None:
        raise NotFound("conversation not found")
    return _conversation_out(db, c, with_messages=True)


@router.post("/conversations/{conversation_id}/messages", status_code=202, tags=["qa"])
def ask(conversation_id: int, body: QuestionIn, db: Session = Depends(get_db), runtime=Depends(runtime_dep)) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    c = db.get(Conversation, conversation_id)
    if c is None:
        raise NotFound("conversation not found")
    if not runtime.enabled:
        raise AgentUnavailable("Agent runtime is disabled by configuration")
    busy = db.scalar(select(Message.id).where(Message.conversation_id == c.id, Message.status == "pending"))
    if busy:
        raise Conflict("A question in this conversation is still being answered")
    snap = _snapshot(db, c.snapshot_id)
    q = Message(conversation_id=c.id, role="user", content=body.content.strip(), status="complete", payload={})
    db.add(q)
    db.flush()
    reply = Message(conversation_id=c.id, role="assistant", content="", status="pending", payload={})
    db.add(reply)
    db.flush()
    job = jobstore.create_qa_job(db, snap.id, snap.repository_id, q.id, reply.id)
    reply.job_id = job.id
    if c.title == "New investigation":
        c.title = body.content.strip()[:120]
    db.commit()
    return {"question_id": q.id, "reply_id": reply.id, "job": JobOut.model_validate(db.get(Job, job.id)).model_dump(mode="json")}
