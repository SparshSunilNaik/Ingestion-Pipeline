"""Separate worker process: exclusive claiming, timeouts, crash diagnostics, cancellation, shutdown requeue."""

import os
import subprocess
import sys
import threading
import time

import pytest
from sqlalchemy import select

from app.core.config import BACKEND_ROOT
from app.database.models import Job
from app.worker_main import Supervisor


@pytest.fixture
def worker_env(settings, monkeypatch):
    # Job children are spawned processes that read settings from the environment.
    monkeypatch.setenv("IP_DATA_DIR", str(settings.data_dir))
    monkeypatch.setenv("IP_ENABLE_SELFTEST_JOBS", "1")
    monkeypatch.setenv("IP_OPENCODE_MODE", "disabled")
    monkeypatch.setenv("IP_LOG_LEVEL", "WARNING")
    from app.core.config import get_settings

    get_settings.cache_clear()
    settings.enable_selftest_jobs = True
    settings.job_lease_seconds = 6
    settings.job_cancel_grace_seconds = 1.0
    settings.job_timeout_seconds = {**settings.job_timeout_seconds, "selftest": 7}
    yield settings
    get_settings.cache_clear()


def add_job(session, **params) -> int:
    job = Job(kind="selftest", requested_url="", params=params, status="queued", stage="queued")
    session.add(job)
    session.commit()
    return job.id


def status(session, job_id):
    return session.get(Job, job_id, populate_existing=True)


def test_success_crash_and_timeout(session, db, worker_env) -> None:
    ok = add_job(session, seconds=0)
    crash = add_job(session, seconds=0, crash=True, exit_code=7)
    slow = add_job(session, seconds=30)
    sup = Supervisor(worker_env, poll_seconds=0.1)
    assert sup.run_once() == ok
    assert sup.run_once() == crash
    assert sup.run_once() == slow
    assert status(session, ok).status == "succeeded"
    c = status(session, crash)
    assert (c.status, c.error_code) == ("failed", "worker_crash") and "code 7" in c.error_message
    s = status(session, slow)
    assert (s.status, s.error_code) == ("failed", "timeout")


def test_cooperative_and_forced_cancellation(session, db, worker_env) -> None:
    from app.ingestion import jobs as jobstore

    coop = add_job(session, seconds=20, cooperative=True)
    forced = add_job(session, seconds=20)
    sup = Supervisor(worker_env, poll_seconds=0.1)
    for jid in (coop, forced):
        t = threading.Timer(1.5, lambda j=jid: jobstore.cancel_job(session.__class__(bind=session.get_bind()), j))
        t.start()
        sup.run_once()
        t.join()
    assert status(session, coop).status == "cancelled" and "cooperatively" in status(session, coop).error_message
    assert status(session, forced).status == "cancelled" and "terminated" in status(session, forced).error_message


def test_shutdown_requeues_running_job(session, db, worker_env) -> None:
    jid = add_job(session, seconds=20)
    sup = Supervisor(worker_env, poll_seconds=0.1)
    threading.Timer(1.5, sup.request_stop).start()
    sup.run_once()
    j = status(session, jid)
    assert (j.status, j.stage, j.worker_id) == ("queued", "requeued", None)


def test_two_worker_processes_never_share_a_job(session, db, worker_env, settings) -> None:
    ids = [add_job(session, seconds=0.3) for _ in range(8)]
    env = {
        **os.environ,
        "IP_DATA_DIR": str(settings.data_dir),
        "IP_ENABLE_SELFTEST_JOBS": "1",
        "IP_OPENCODE_MODE": "disabled",
        "IP_LOG_LEVEL": "WARNING",
        "IP_WORKER_POLL_SECONDS": "0.1",
    }
    code = (
        "from app.worker_main import Supervisor; from app.core.config import get_settings; from app.database.engine import init_engine; "
        "s = get_settings(); init_engine(s.resolved_database_url); Supervisor(s).run_forever(max_jobs=4)"
    )
    procs = [subprocess.Popen([sys.executable, "-c", code], cwd=str(BACKEND_ROOT), env=env) for _ in range(2)]
    for p in procs:
        p.wait(120)
    jobs = session.scalars(select(Job).where(Job.id.in_(ids)).execution_options(populate_existing=True)).all()
    assert all(j.status == "succeeded" for j in jobs)
    assert all(j.attempts == 1 for j in jobs)  # each claimed exactly once
    assert len({j.worker_id for j in jobs}) == 2  # both processes did work


def test_api_supervises_worker_subprocess(settings, sample_remote, monkeypatch) -> None:
    """worker_mode=subprocess: the API starts a separate worker process and stops it on shutdown."""
    from fastapi.testclient import TestClient

    from app.main import create_app

    settings.start_worker = True
    settings.worker_mode = "subprocess"
    monkeypatch.setenv("IP_LOG_LEVEL", "WARNING")
    app = create_app(settings)
    with TestClient(app, headers={"Authorization": f"Bearer {app.state.auth.token}"}) as c:
        proc = app.state.worker_process
        assert proc is not None and proc.alive
        assert c.get("/api/health/ready").json()["worker_running"] is True
        pid = proc.proc.pid
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and _pid_alive(pid):
        time.sleep(0.2)
    assert not _pid_alive(pid)


def _pid_alive(pid: int) -> bool:
    if sys.platform == "win32":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def test_supervisor_survives_heartbeat_db_errors(session, db, worker_env, monkeypatch) -> None:
    """Regression: a 'database is locked' during heartbeat used to kill the worker process."""
    import sqlalchemy

    from app.ingestion import jobs as jobstore

    def locked(*_a, **_k):
        raise sqlalchemy.exc.OperationalError("UPDATE jobs", {}, Exception("database is locked"))

    monkeypatch.setattr(jobstore, "heartbeat", locked)
    jid = add_job(session, seconds=3)  # several heartbeat intervals (lease 6s -> beat every 2s), below the 7s timeout
    sup = Supervisor(worker_env, poll_seconds=0.1)
    assert sup.run_once() == jid
    j = status(session, jid)
    assert j.status == "succeeded", (j.error_code, j.error_message)


def test_api_restarts_dead_worker(settings, monkeypatch) -> None:
    from fastapi.testclient import TestClient

    from app.main import create_app

    settings.start_worker = True
    settings.worker_mode = "subprocess"
    monkeypatch.setenv("IP_LOG_LEVEL", "WARNING")
    app = create_app(settings)
    with TestClient(app, headers={"Authorization": f"Bearer {app.state.auth.token}"}):
        wp = app.state.worker_process
        first = wp.proc.pid
        wp.proc.kill()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and (wp.proc is None or wp.proc.pid == first or not wp.alive):
            time.sleep(0.3)
        assert wp.alive and wp.proc.pid != first and wp.restarts == 1
