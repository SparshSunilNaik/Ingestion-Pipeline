"""Job queue on SQLite with atomic claiming, leases and stale-job recovery."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound
from app.database.models import Job, Repository
from app.ingestion.url import parse_github_url

ACTIVE = ("queued", "running")
TERMINAL = ("succeeded", "failed", "cancelled")
ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "queued": {"running", "cancelled"},
    "running": {"succeeded", "failed", "cancelled", "queued"},  # queued = recovered after interruption
    "succeeded": set(),
    "failed": set(),
    "cancelled": set(),
}
MAX_ATTEMPTS = 3


def now() -> datetime:
    return datetime.now(UTC)


def _sql_ts(value: datetime) -> str:
    """Same text format SQLAlchemy uses for SQLite DateTime columns (naive UTC)."""
    return value.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S.%f")


def check_transition(current: str, new: str) -> None:
    if new not in ALLOWED_TRANSITIONS.get(current, set()):
        raise Conflict(f"invalid job transition {current} -> {new}")


def get_or_create_repository(session: Session, owner: str, name: str, canonical_url: str) -> Repository:
    repo = session.scalar(select(Repository).where(Repository.owner == owner, Repository.name == name))
    if repo is None:
        repo = Repository(owner=owner, name=name, canonical_url=canonical_url)
        session.add(repo)
        session.flush()
    return repo


def create_ingest_job(session: Session, url: str) -> tuple[Job, bool]:
    """Validate URL and enqueue. Returns (job, created). An active job for the same repo is reused."""
    ref = parse_github_url(url)
    repo = get_or_create_repository(session, ref.owner.lower(), ref.name.lower(), f"https://github.com/{ref.owner.lower()}/{ref.name.lower()}")
    existing = session.scalar(select(Job).where(Job.repository_id == repo.id, Job.kind == "ingest", Job.status.in_(ACTIVE)).order_by(Job.id))
    if existing is not None:
        return existing, False
    job = Job(kind="ingest", repository_id=repo.id, requested_url=repo.canonical_url, params={}, status="queued", stage="queued")
    session.add(job)
    session.flush()
    return job, True


def create_agent_job(session: Session, snapshot_id: int, repository_id: int, model: str) -> tuple[Job, bool]:
    existing = session.scalar(select(Job).where(Job.snapshot_id == snapshot_id, Job.kind == "agent_report", Job.status.in_(ACTIVE)))
    if existing is not None:
        return existing, False
    job = Job(
        kind="agent_report", repository_id=repository_id, snapshot_id=snapshot_id, requested_url="", params={"model": model}, status="queued", stage="queued"
    )
    session.add(job)
    session.flush()
    return job, True


def claim_next_job(session: Session, worker_id: str, lease_seconds: int) -> int | None:
    """Atomically claim the oldest queued job. Safe against concurrent workers:
    the UPDATE re-checks ``status='queued'`` and SQLite serialises writers."""
    ts = now()
    row = session.execute(
        text(
            "UPDATE jobs SET status='running', worker_id=:w, lease_expires_at=:exp, "
            "started_at=COALESCE(started_at, :now), attempts=attempts+1, stage='starting' "
            "WHERE id = (SELECT id FROM jobs WHERE status='queued' ORDER BY created_at, id LIMIT 1) "
            "AND status='queued' RETURNING id"
        ),
        {"w": worker_id, "exp": _sql_ts(ts + timedelta(seconds=lease_seconds)), "now": _sql_ts(ts)},
    ).first()
    session.commit()
    session.expire_all()  # raw UPDATE bypassed the identity map
    return int(row[0]) if row else None


def heartbeat(session: Session, job_id: int, worker_id: str, lease_seconds: int) -> bool:
    res = session.execute(
        text("UPDATE jobs SET lease_expires_at=:exp WHERE id=:id AND worker_id=:w AND status='running'"),
        {"exp": _sql_ts(now() + timedelta(seconds=lease_seconds)), "id": job_id, "w": worker_id},
    )
    session.commit()
    session.expire_all()
    return bool(getattr(res, "rowcount", 0))


def recover_stale_jobs(session: Session) -> int:
    """Requeue (or fail after MAX_ATTEMPTS) running jobs whose lease expired, e.g. after a crash."""
    stale = session.scalars(select(Job).where(Job.status == "running", Job.lease_expires_at < now()).execution_options(populate_existing=True)).all()
    for job in stale:
        if job.attempts >= MAX_ATTEMPTS:
            job.status = "failed"
            job.error_code = "interrupted"
            job.error_message = f"Job interrupted {job.attempts} times; giving up"
            job.finished_at = now()
        else:
            job.status = "queued"
            job.stage = "requeued"
            job.message = "Recovered after interruption"
        job.worker_id = None
        job.lease_expires_at = None
    session.commit()
    return len(stale)


def update_progress(session: Session, job_id: int, stage: str, progress: int, message: str | None = None) -> None:
    job = session.get(Job, job_id, populate_existing=True)
    if job is None:
        raise NotFound("job not found")
    job.stage = stage
    job.progress = max(0, min(100, progress))
    if message is not None:
        job.message = message[:2000]
    session.commit()


def finish_job(
    session: Session,
    job_id: int,
    status: str,
    *,
    error_code: str | None = None,
    error_message: str | None = None,
    snapshot_id: int | None = None,
    reused: bool | None = None,
) -> None:
    job = session.get(Job, job_id, populate_existing=True)
    if job is None:
        raise NotFound("job not found")
    check_transition(job.status, status)
    job.status = status
    job.finished_at = now()
    job.lease_expires_at = None
    if status == "succeeded":
        job.progress = 100
        job.stage = "complete"
    if error_code:
        job.error_code = error_code
        job.error_message = (error_message or "")[:4000]
        job.stage = "failed" if status == "failed" else job.stage
    if snapshot_id is not None:
        job.snapshot_id = snapshot_id
    if reused is not None:
        job.reused_cache = reused
    session.commit()


def cancel_job(session: Session, job_id: int) -> Job:
    job = session.get(Job, job_id, populate_existing=True)
    if job is None:
        raise NotFound("job not found")
    if job.status == "queued":
        check_transition(job.status, "cancelled")
        job.status = "cancelled"
        job.finished_at = now()
    elif job.status == "running":
        job.params = {**(job.params or {}), "cancel_requested": True}
        job.message = "Cancellation requested"
    else:
        raise Conflict(f"job already {job.status}")
    session.commit()
    return job


def cancel_requested(session: Session, job_id: int) -> bool:
    job = session.get(Job, job_id, populate_existing=True)
    return bool(job and (job.params or {}).get("cancel_requested"))
