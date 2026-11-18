import threading
from datetime import timedelta

import pytest

from app.core.errors import Conflict, InvalidRepositoryUrl
from app.database.engine import session_factory
from app.database.models import Job
from app.ingestion import jobs


def test_transitions() -> None:
    jobs.check_transition("queued", "running")
    jobs.check_transition("running", "succeeded")
    jobs.check_transition("running", "queued")
    for cur, new in [("succeeded", "running"), ("failed", "queued"), ("queued", "succeeded"), ("cancelled", "running")]:
        with pytest.raises(Conflict):
            jobs.check_transition(cur, new)


def test_create_validates_and_dedups(session) -> None:
    with pytest.raises(InvalidRepositoryUrl):
        jobs.create_ingest_job(session, "https://evil.com/a/b")
    j1, created1 = jobs.create_ingest_job(session, "https://github.com/Acme/Thing")
    j2, created2 = jobs.create_ingest_job(session, "https://github.com/acme/thing.git")
    session.commit()
    assert created1 and not created2 and j1.id == j2.id
    assert j1.requested_url == "https://github.com/acme/thing"


def test_claim_is_exclusive_across_threads(session) -> None:
    for i in range(10):
        jobs.create_ingest_job(session, f"https://github.com/acme/repo{i}")
    session.commit()
    claimed: list[int] = []
    lock = threading.Lock()

    def worker(name: str) -> None:
        s = session_factory()()
        try:
            while True:
                jid = jobs.claim_next_job(s, name, 60)
                if jid is None:
                    return
                with lock:
                    claimed.append(jid)
        finally:
            s.close()

    threads = [threading.Thread(target=worker, args=(f"w{i}",)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(claimed) == sorted(set(claimed))
    assert len(claimed) == 10


def test_stale_job_recovery(session) -> None:
    job, _ = jobs.create_ingest_job(session, "https://github.com/acme/x")
    session.commit()
    jid = jobs.claim_next_job(session, "w1", 60)
    assert jid == job.id
    assert jobs.heartbeat(session, jid, "w1", 60)
    assert not jobs.heartbeat(session, jid, "someone-else", 60)
    j = session.get(Job, jid)
    j.lease_expires_at = jobs.now() - timedelta(seconds=5)
    session.commit()
    assert jobs.recover_stale_jobs(session) == 1
    session.refresh(j)
    assert (j.status, j.stage, j.worker_id) == ("queued", "requeued", None)
    # exhausting attempts fails the job instead of looping forever
    for _ in range(jobs.MAX_ATTEMPTS):
        jobs.claim_next_job(session, "w1", 60)
        j = session.get(Job, jid)
        j.lease_expires_at = jobs.now() - timedelta(seconds=5)
        session.commit()
        jobs.recover_stale_jobs(session)
    session.refresh(j)
    assert j.status == "failed" and j.error_code == "interrupted"


def test_cancel(session) -> None:
    job, _ = jobs.create_ingest_job(session, "https://github.com/acme/c")
    session.commit()
    assert jobs.cancel_job(session, job.id).status == "cancelled"
    with pytest.raises(Conflict):
        jobs.cancel_job(session, job.id)
    job2, _ = jobs.create_ingest_job(session, "https://github.com/acme/c")
    session.commit()
    jobs.claim_next_job(session, "w", 60)
    jobs.cancel_job(session, job2.id)
    assert jobs.cancel_requested(session, job2.id)
