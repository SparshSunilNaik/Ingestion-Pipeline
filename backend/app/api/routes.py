"""HTTP API routes."""

from __future__ import annotations

import shutil
from collections import deque

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy import func, or_, select, text
from sqlalchemy.orm import Session

from app.agents.opencode_adapter import split_model_id
from app.agents.runtime import OpenCodeRuntime
from app.agents.service import selected_model, set_selected_model
from app.core.config import Settings
from app.core.errors import AgentError, AgentUnavailable, AppError, Conflict, InvalidRepositoryUrl, NotFound, ValidationFailed
from app.database.engine import get_db
from app.database.models import Dependency, Evidence, FileRecord, Finding, GraphEdge, GraphNode, Job, Report, Repository, Snapshot, Symbol
from app.evidence.verifier import SnapshotReader, verify_evidence, verify_location
from app.ingestion import jobs as jobstore
from app.ingestion.url import parse_github_url
from app.schemas import api as s
from app.search.fts import search as fts_search

router = APIRouter(prefix="/api")
VERSION = "0.1.0"


def settings_dep(request: Request) -> Settings:
    return request.app.state.settings


def runtime_dep(request: Request) -> OpenCodeRuntime:
    return request.app.state.runtime


def _snapshot(db: Session, snapshot_id: int) -> Snapshot:
    snap = db.get(Snapshot, snapshot_id)
    if snap is None:
        raise NotFound("snapshot not found")
    return snap


# ---------------------------------------------------------------- health
@router.get("/health", response_model=s.HealthOut, tags=["health"])
def health(settings: Settings = Depends(settings_dep)) -> s.HealthOut:
    return s.HealthOut(status="ok", app=settings.app_name, version=VERSION)


@router.get("/health/ready", response_model=s.ReadinessOut, tags=["health"])
def ready(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(settings_dep)) -> s.ReadinessOut:
    db_ok = True
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        db_ok = False
    worker = getattr(request.app.state, "worker", None)
    runtime: OpenCodeRuntime = request.app.state.runtime
    agent = {"mode": settings.opencode.mode, "enabled": runtime.enabled}
    return s.ReadinessOut(
        status="ok" if db_ok else "degraded",
        database=db_ok,
        git=shutil.which(settings.git_executable),
        worker_running=bool(worker and worker._thread and worker._thread.is_alive()),
        agent=agent,
    )


# ---------------------------------------------------------------- ingestion
@router.post("/repositories/validate", response_model=s.UrlValidationOut, tags=["ingestion"])
def validate_url(body: s.UrlIn) -> s.UrlValidationOut:
    try:
        ref = parse_github_url(body.url)
    except InvalidRepositoryUrl as exc:
        return s.UrlValidationOut(valid=False, error=exc.message)
    return s.UrlValidationOut(valid=True, canonical_url=ref.canonical_url, owner=ref.owner, name=ref.name)


@router.post("/jobs", response_model=s.JobCreatedOut, status_code=202, tags=["ingestion"])
def create_job(body: s.UrlIn, response: Response, db: Session = Depends(get_db)) -> s.JobCreatedOut:
    job, created = jobstore.create_ingest_job(db, body.url)
    db.commit()
    if not created:
        response.status_code = 200
    return s.JobCreatedOut(job=s.JobOut.model_validate(job), created=created)


@router.get("/jobs", response_model=list[s.JobOut], tags=["ingestion"])
def list_jobs(limit: int = Query(50, ge=1, le=200), repository_id: int | None = None, db: Session = Depends(get_db)) -> list[Job]:
    q = select(Job).order_by(Job.id.desc()).limit(limit)
    if repository_id is not None:
        q = q.where(Job.repository_id == repository_id)
    return list(db.scalars(q))


@router.get("/jobs/{job_id}", response_model=s.JobOut, tags=["ingestion"])
def get_job(job_id: int, db: Session = Depends(get_db)) -> Job:
    job = db.get(Job, job_id)
    if job is None:
        raise NotFound("job not found")
    return job


@router.post("/jobs/{job_id}/cancel", response_model=s.JobOut, tags=["ingestion"])
def cancel_job(job_id: int, db: Session = Depends(get_db)) -> Job:
    return jobstore.cancel_job(db, job_id)


# ---------------------------------------------------------------- repositories & snapshots
@router.get("/repositories", response_model=list[s.RepositoryDetailOut], tags=["repositories"])
def list_repositories(db: Session = Depends(get_db)) -> list[s.RepositoryDetailOut]:
    out = []
    for repo in db.scalars(select(Repository).order_by(Repository.updated_at.desc())):
        out.append(_repo_detail(db, repo))
    return out


def _repo_detail(db: Session, repo: Repository) -> s.RepositoryDetailOut:
    snaps = [s.SnapshotBrief.model_validate(x) for x in sorted(repo.snapshots, key=lambda x: x.acquired_at, reverse=True)]
    current = next((x for x in snaps if x.id == repo.current_snapshot_id), None)
    latest = db.scalar(select(Job).where(Job.repository_id == repo.id).order_by(Job.id.desc()).limit(1))
    base = s.RepositoryOut.model_validate(repo).model_dump()
    return s.RepositoryDetailOut(**base, snapshots=snaps, current=current, latest_job=s.JobOut.model_validate(latest) if latest else None)


@router.get("/repositories/{repo_id}", response_model=s.RepositoryDetailOut, tags=["repositories"])
def get_repository(repo_id: int, db: Session = Depends(get_db)) -> s.RepositoryDetailOut:
    repo = db.get(Repository, repo_id)
    if repo is None:
        raise NotFound("repository not found")
    return _repo_detail(db, repo)


@router.get("/snapshots/{snapshot_id}", response_model=s.SnapshotOut, tags=["snapshots"])
def get_snapshot(snapshot_id: int, db: Session = Depends(get_db)) -> Snapshot:
    return _snapshot(db, snapshot_id)


@router.get("/snapshots/{snapshot_id}/files", response_model=s.Page[s.FileOut], tags=["snapshots"])
def list_files(
    snapshot_id: int,
    category: str | None = None,
    analyzed: bool | None = None,
    q: str | None = Query(None, max_length=200),
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=1000),
    db: Session = Depends(get_db),
) -> s.Page[s.FileOut]:
    _snapshot(db, snapshot_id)
    cond = [FileRecord.snapshot_id == snapshot_id]
    if category:
        cond.append(FileRecord.category == category)
    if analyzed is not None:
        cond.append(FileRecord.analyzed.is_(analyzed))
    if q:
        cond.append(FileRecord.path.contains(q))
    total = db.scalar(select(func.count()).select_from(FileRecord).where(*cond)) or 0
    rows = db.scalars(select(FileRecord).where(*cond).order_by(FileRecord.path).offset(offset).limit(limit)).all()
    return s.Page[s.FileOut](total=total, items=[s.FileOut.model_validate(r) for r in rows])


@router.get("/snapshots/{snapshot_id}/source", response_model=s.SourceOut, tags=["snapshots"])
def get_source(
    snapshot_id: int, path: str = Query(max_length=1000), start: int = Query(1, ge=1), end: int | None = Query(None, ge=1), db: Session = Depends(get_db)
) -> s.SourceOut:
    snap = _snapshot(db, snapshot_id)
    reader = SnapshotReader(db, snap)
    rec = reader.readable(path)
    lines = reader.lines(path) if rec else None
    if rec is None or lines is None:
        raise NotFound("file is not an analysed file of this snapshot")
    n = len(lines)
    end = min(end or n, n, start + 2000)
    start = min(start, max(n, 1))
    return s.SourceOut(path=path, start_line=start, end_line=end, total_lines=n, language=rec.language, lines=lines[start - 1 : end])


@router.get("/snapshots/{snapshot_id}/symbols", response_model=list[s.SymbolOut], tags=["analysis"])
def list_symbols(
    snapshot_id: int,
    q: str | None = Query(None, max_length=200),
    kind: str | None = None,
    path: str | None = None,
    limit: int = Query(200, ge=1, le=1000),
    db: Session = Depends(get_db),
) -> list[Symbol]:
    _snapshot(db, snapshot_id)
    cond = [Symbol.snapshot_id == snapshot_id]
    if q:
        cond.append(or_(Symbol.name.contains(q), Symbol.qualified_name.contains(q)))
    if kind:
        cond.append(Symbol.kind == kind)
    if path:
        cond.append(Symbol.path == path)
    return list(db.scalars(select(Symbol).where(*cond).order_by(Symbol.path, Symbol.start_line).limit(limit)))


@router.get("/snapshots/{snapshot_id}/dependencies", response_model=list[s.DependencyOut], tags=["analysis"])
def list_dependencies(snapshot_id: int, db: Session = Depends(get_db)) -> list[Dependency]:
    _snapshot(db, snapshot_id)
    return list(db.scalars(select(Dependency).where(Dependency.snapshot_id == snapshot_id).order_by(Dependency.ecosystem, Dependency.name)))


@router.get("/snapshots/{snapshot_id}/findings", response_model=list[s.FindingOut], tags=["analysis"])
def list_findings(snapshot_id: int, kind: str | None = None, db: Session = Depends(get_db)) -> list[Finding]:
    _snapshot(db, snapshot_id)
    q = select(Finding).where(Finding.snapshot_id == snapshot_id)
    if kind:
        q = q.where(Finding.kind == kind)
    return list(db.scalars(q.order_by(Finding.kind, Finding.id)))


@router.get("/snapshots/{snapshot_id}/search", response_model=list[s.SearchHit], tags=["analysis"])
def search_code(
    snapshot_id: int, q: str = Query(min_length=2, max_length=200), limit: int = Query(20, ge=1, le=50), db: Session = Depends(get_db)
) -> list[dict]:
    _snapshot(db, snapshot_id)
    return fts_search(db, snapshot_id, q, limit)


GRAPH_VIEWS = {
    "files": ({"file", "package", "route"}, {"imports", "declares_route", "declares_dependency"}),
    "symbols": (
        {"file", "function", "class", "method", "route", "interface", "type", "enum", "variable"},
        {"contains", "calls", "inherits", "handled_by", "declares_route"},
    ),
}


@router.get("/snapshots/{snapshot_id}/graph", response_model=s.GraphOut, tags=["graph"])
def get_graph(
    snapshot_id: int,
    view: str = Query("files", pattern="^(files|symbols)$"),
    path_prefix: str | None = Query(None, max_length=500),
    include_unresolved: bool = False,
    limit: int = Query(400, ge=10, le=3000),
    db: Session = Depends(get_db),
) -> s.GraphOut:
    _snapshot(db, snapshot_id)
    node_kinds, edge_kinds = GRAPH_VIEWS[view]
    if include_unresolved:
        node_kinds = node_kinds | {"unresolved"}
    nq = select(GraphNode).where(GraphNode.snapshot_id == snapshot_id, GraphNode.kind.in_(node_kinds))
    if path_prefix:
        nq = nq.where(or_(GraphNode.path.startswith(path_prefix), GraphNode.path.is_(None)))
    all_nodes = db.scalars(nq).all()
    edges = db.scalars(select(GraphEdge).where(GraphEdge.snapshot_id == snapshot_id, GraphEdge.kind.in_(edge_kinds))).all()
    keyset = {n.key for n in all_nodes}
    edges = [e for e in edges if e.source_key in keyset and e.target_key in keyset]
    degree: dict[str, int] = {}
    for e in edges:
        degree[e.source_key] = degree.get(e.source_key, 0) + 1
        degree[e.target_key] = degree.get(e.target_key, 0) + 1
    # Keep the most connected nodes when truncating; packages only if connected.
    ranked = sorted(all_nodes, key=lambda n: (-degree.get(n.key, 0), n.key))
    ranked = [n for n in ranked if n.kind != "package" or degree.get(n.key)]
    chosen = ranked[:limit]
    chosen_keys = {n.key for n in chosen}
    out_edges = [e for e in edges if e.source_key in chosen_keys and e.target_key in chosen_keys]
    return s.GraphOut(
        view=view,
        nodes=[
            s.GraphNodeOut(key=n.key, kind=n.kind, label=n.label, path=n.path, start_line=n.start_line, end_line=n.end_line, attrs=n.attrs or {})
            for n in chosen
        ],
        edges=[
            s.GraphEdgeOut(
                source=e.source_key,
                target=e.target_key,
                kind=e.kind,
                resolution=e.resolution,
                evidence_id=e.evidence_id,
                count=int((e.attrs or {}).get("count", 1)),
            )
            for e in out_edges
        ],
        truncated=len(ranked) > limit,
        totals={"nodes": len(ranked), "edges": len(edges)},
    )


@router.get("/snapshots/{snapshot_id}/impact", response_model=s.ImpactOut, tags=["graph"])
def impact(snapshot_id: int, key: str = Query(max_length=1200), depth: int = Query(3, ge=1, le=6), db: Session = Depends(get_db)) -> s.ImpactOut:
    """What could be affected if `key` changes: reverse traversal over resolved imports/calls/inheritance."""
    _snapshot(db, snapshot_id)
    nodes = {n.key: n for n in db.scalars(select(GraphNode).where(GraphNode.snapshot_id == snapshot_id))}
    if key not in nodes:
        raise NotFound("graph node not found")
    rev: dict[str, list[tuple[str, str]]] = {}
    contains_children: dict[str, list[str]] = {}
    for e in db.scalars(select(GraphEdge).where(GraphEdge.snapshot_id == snapshot_id, GraphEdge.resolution == "resolved")):
        if e.kind in ("imports", "calls", "inherits", "handled_by"):
            rev.setdefault(e.target_key, []).append((e.source_key, e.kind))
        elif e.kind == "contains":
            contains_children.setdefault(e.source_key, []).append(e.target_key)
    seeds = [key]
    if key.startswith("file:"):
        seeds += _descendants(contains_children, key)
    seen = {k: 0 for k in seeds}
    queue = deque((k, 0) for k in seeds)
    result: list[s.ImpactItem] = []
    while queue and len(result) < 500:
        cur, d = queue.popleft()
        if d >= depth:
            continue
        for src, kind in rev.get(cur, []):
            if src in seen:
                continue
            seen[src] = d + 1
            n = nodes.get(src)
            result.append(s.ImpactItem(key=src, kind=n.kind if n else None, label=n.label if n else None, depth=d + 1, via=kind))
            queue.append((src, d + 1))
    return s.ImpactOut(
        key=key,
        dependents=result,
        truncated=len(result) >= 500,
        note="Static, resolved references only. Dynamic dispatch, reflection, configuration and runtime wiring are not modelled.",
    )


def _descendants(children: dict[str, list[str]], key: str) -> list[str]:
    out, stack = [], list(children.get(key, []))
    while stack:
        k = stack.pop()
        out.append(k)
        stack.extend(children.get(k, []))
    return out


# ---------------------------------------------------------------- evidence
@router.get("/evidence/{evidence_id}", response_model=s.EvidenceDetailOut, tags=["evidence"])
def get_evidence(evidence_id: str, db: Session = Depends(get_db)) -> s.EvidenceDetailOut:
    ev = db.get(Evidence, evidence_id)
    if ev is None:
        raise NotFound("evidence not found")
    snap = _snapshot(db, ev.snapshot_id)
    reader = SnapshotReader(db, snap)
    res = verify_evidence(reader, ev)
    excerpt = reader.excerpt(ev.path, ev.start_line, min(ev.end_line, ev.start_line + 200)) if res.ok else None
    return s.EvidenceDetailOut(**s.EvidenceOut.model_validate(ev).model_dump(), verified_now=res.ok, verification_reason=res.reason, excerpt=excerpt)


@router.post("/snapshots/{snapshot_id}/verify-location", response_model=s.LocationVerificationOut, tags=["evidence"])
def verify_loc(snapshot_id: int, body: s.LocationIn, db: Session = Depends(get_db)) -> s.LocationVerificationOut:
    snap = _snapshot(db, snapshot_id)
    res = verify_location(SnapshotReader(db, snap), body.path, body.start_line, body.end_line)
    return s.LocationVerificationOut(ok=res.ok, reason=res.reason)


# ---------------------------------------------------------------- reports
@router.get("/snapshots/{snapshot_id}/reports", response_model=list[s.ReportBrief], tags=["reports"])
def list_reports(snapshot_id: int, db: Session = Depends(get_db)) -> list[Report]:
    _snapshot(db, snapshot_id)
    return list(db.scalars(select(Report).where(Report.snapshot_id == snapshot_id).order_by(Report.id.desc())))


@router.get("/reports/{report_id}", response_model=s.ReportOut, tags=["reports"])
def get_report(report_id: int, db: Session = Depends(get_db)) -> Report:
    rep = db.get(Report, report_id)
    if rep is None:
        raise NotFound("report not found")
    return rep


@router.get("/reports/{report_id}/markdown", tags=["reports"], response_class=Response)
def get_report_markdown(report_id: int, db: Session = Depends(get_db)) -> Response:
    rep = db.get(Report, report_id)
    if rep is None:
        raise NotFound("report not found")
    return Response(
        content=rep.markdown, media_type="text/markdown; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="report-{report_id}.md"'}
    )


@router.post("/snapshots/{snapshot_id}/agent-report", response_model=s.JobCreatedOut, status_code=202, tags=["agent"])
def request_agent_report(
    snapshot_id: int,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(settings_dep),
    runtime: OpenCodeRuntime = Depends(runtime_dep),
) -> s.JobCreatedOut:
    snap = _snapshot(db, snapshot_id)
    if snap.status != "ready":
        raise Conflict("snapshot is not ready")
    if not runtime.enabled:
        raise AgentUnavailable("Agent runtime is disabled by configuration")
    job, created = jobstore.create_agent_job(db, snap.id, snap.repository_id, selected_model(db, settings))
    db.commit()
    if not created:
        response.status_code = 200
    return s.JobCreatedOut(job=s.JobOut.model_validate(job), created=created)


# ---------------------------------------------------------------- agent settings
@router.get("/agent/status", response_model=s.AgentStatusOut, tags=["agent"])
def agent_status(
    db: Session = Depends(get_db), settings: Settings = Depends(settings_dep), runtime: OpenCodeRuntime = Depends(runtime_dep)
) -> s.AgentStatusOut:
    model = selected_model(db, settings)
    info = runtime.status()
    model_ok: bool | None = None
    error = info.error
    if info.available:
        adapter = runtime.adapter(timeout=10)
        try:
            model_ok = any(m.id == model and m.enabled for m in adapter.list_models())
            if not model_ok:
                error = f"Selected model {model} is not available; choose another configured model."
        except AppError as exc:
            error = exc.message
        finally:
            adapter.close()
    return s.AgentStatusOut(
        mode=settings.opencode.mode,
        available=info.available,
        version=info.version,
        base_url=info.base_url,
        error=error,
        selected_model=model,
        selected_model_available=model_ok,
        agent_ready=bool(info.available and model_ok),
    )


@router.get("/agent/models", response_model=list[s.AgentModelOut], tags=["agent"])
def agent_models(runtime: OpenCodeRuntime = Depends(runtime_dep)) -> list[s.AgentModelOut]:
    if not runtime.enabled:
        raise AgentUnavailable("Agent runtime is disabled by configuration")
    adapter = runtime.adapter(timeout=15)
    try:
        return [s.AgentModelOut(**m.__dict__) for m in adapter.list_models()]
    finally:
        adapter.close()


@router.put("/agent/model", response_model=s.AgentStatusOut, tags=["agent"])
def select_model(
    body: s.ModelSelectIn, db: Session = Depends(get_db), settings: Settings = Depends(settings_dep), runtime: OpenCodeRuntime = Depends(runtime_dep)
) -> s.AgentStatusOut:
    try:
        split_model_id(body.model)
    except AgentError as exc:
        raise ValidationFailed(exc.message) from exc
    if not runtime.enabled:
        raise AgentUnavailable("Agent runtime is disabled by configuration")
    adapter = runtime.adapter(timeout=15)
    try:
        adapter.resolve_model(body.model)
    except AgentUnavailable as exc:
        raise ValidationFailed(exc.message) from exc
    finally:
        adapter.close()
    set_selected_model(db, body.model)
    return agent_status(db, settings, runtime)
