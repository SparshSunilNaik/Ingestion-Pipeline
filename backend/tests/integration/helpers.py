from __future__ import annotations

from sqlalchemy.orm import Session

from app.database.models import Job, Snapshot
from app.ingestion import jobs
from app.ingestion.pipeline import IngestionPipeline, run_ingest


def ingest(session: Session, pipeline: IngestionPipeline, url: str = "https://github.com/acme/sample") -> Job:
    job, _ = jobs.create_ingest_job(session, url)
    session.commit()
    jid = jobs.claim_next_job(session, "test-worker", 120)
    assert jid == job.id
    run_ingest(session, pipeline, jid)
    session.expire_all()
    out = session.get(Job, jid)
    assert out is not None
    return out


def ready_snapshot(session: Session, pipeline: IngestionPipeline) -> Snapshot:
    job = ingest(session, pipeline)
    assert job.status == "succeeded", (job.error_code, job.error_message)
    snap = session.get(Snapshot, job.snapshot_id)
    assert snap is not None
    return snap
