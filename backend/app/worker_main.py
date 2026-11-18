"""Standalone worker process: `python -m app.worker_main`.

Supervisor loop (this process):
  * recovers stale jobs, claims one job atomically (exclusive across any number of workers),
  * runs it in a dedicated child process (multiprocessing "spawn"),
  * renews the job lease while the child runs,
  * enforces a per-kind timeout and forced cancellation (kills the child after a grace period),
  * records a diagnostic failure if the child crashes (non-zero exit without finishing the job),
  * on shutdown (SIGINT/SIGTERM/CTRL_BREAK) stops claiming, waits for the running child up to the
    grace period, then kills it and puts the job back in the queue.
"""

from __future__ import annotations

import multiprocessing as mp
import os
import signal
import sys
import threading
import time
import uuid
from datetime import UTC, datetime

from app.core.config import Settings, get_settings
from app.core.logging import configure_logging, get_logger
from app.database.engine import init_engine, session_factory
from app.database.models import Job
from app.ingestion import jobs as jobstore

log = get_logger("app.worker")


def run_job_in_child(job_id: int) -> None:
    """Entry point of the per-job child process."""
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    init_engine(settings.resolved_database_url)
    from app.agents.runtime import OpenCodeRuntime
    from app.agents.service import run_agent_job, run_qa_job
    from app.ingestion.pipeline import IngestionPipeline, run_ingest

    session = session_factory()()
    try:
        job = session.get(Job, job_id)
        if job is None:
            return
        if job.kind == "ingest":
            run_ingest(session, IngestionPipeline(settings), job_id)
        elif job.kind == "agent_report":
            run_agent_job(session, OpenCodeRuntime(settings), job_id)
        elif job.kind == "qa":
            run_qa_job(session, OpenCodeRuntime(settings), job_id)
        elif job.kind == "selftest" and settings.enable_selftest_jobs:
            _selftest(session, job)
        else:
            jobstore.finish_job(session, job_id, "failed", error_code="unknown_job_kind", error_message=job.kind)
    finally:
        session.close()


def _selftest(session, job: Job) -> None:  # type: ignore[no-untyped-def]
    """Diagnostic job used by the worker lifecycle tests (enabled only with IP_ENABLE_SELFTEST_JOBS=1)."""
    p = job.params or {}
    end = time.monotonic() + float(p.get("seconds", 0))
    while time.monotonic() < end:
        if p.get("cooperative") and jobstore.cancel_requested(session, job.id):
            jobstore.finish_job(session, job.id, "cancelled", error_code="cancelled", error_message="cancelled cooperatively")
            return
        time.sleep(0.2)
    if p.get("crash"):
        os._exit(int(p.get("exit_code", 3)))
    jobstore.finish_job(session, job.id, "succeeded")


class Supervisor:
    def __init__(self, settings: Settings, poll_seconds: float | None = None) -> None:
        self.settings = settings
        self.worker_id = f"proc-{os.getpid()}-{uuid.uuid4().hex[:6]}"
        self.poll = poll_seconds or settings.worker_poll_seconds
        self.stop_event = threading.Event()
        self.ctx = mp.get_context("spawn")

    def request_stop(self, *_: object) -> None:
        log.info("worker %s: shutdown requested", self.worker_id)
        self.stop_event.set()

    def run_forever(self, max_jobs: int | None = None) -> int:
        done = 0
        log.info("worker %s started (pid %s)", self.worker_id, os.getpid())
        while not self.stop_event.is_set():
            try:
                ran = self.run_once()
            except Exception:
                log.exception("worker %s: loop error; continuing", self.worker_id)
                ran = None
            if ran is not None:
                done += 1
                if max_jobs is not None and done >= max_jobs:
                    break
            else:
                self.stop_event.wait(self.poll)
        log.info("worker %s stopped after %s job(s)", self.worker_id, done)
        return done

    def run_once(self) -> int | None:
        session = session_factory()()
        try:
            jobstore.recover_stale_jobs(session)
            job_id = jobstore.claim_next_job(session, self.worker_id, self.settings.job_lease_seconds)
            if job_id is None:
                return None
            job = session.get(Job, job_id, populate_existing=True)
            assert job is not None
            timeout = float(self.settings.job_timeout_seconds.get(job.kind, 900))
            child = self.ctx.Process(target=run_job_in_child, args=(job_id,), name=f"job-{job_id}", daemon=False)
            child.start()
            started = time.monotonic()
            cancel_seen: float | None = None
            outcome = "exited"
            interval = max(0.5, min(5.0, self.settings.job_lease_seconds / 3))
            while child.is_alive():
                child.join(interval)
                if not child.is_alive():
                    break
                try:
                    jobstore.heartbeat(session, job_id, self.worker_id, self.settings.job_lease_seconds)
                except Exception as exc:  # transient (e.g. SQLite busy); the lease has slack for missed beats
                    session.rollback()
                    log.warning("heartbeat for job %s failed: %s", job_id, type(exc).__name__)
                if self.stop_event.is_set():
                    child.join(self.settings.job_cancel_grace_seconds)
                    if child.is_alive():
                        outcome = "shutdown"
                        child.kill()
                        child.join(10)
                    break
                try:
                    cancelled = jobstore.cancel_requested(session, job_id)
                except Exception:
                    session.rollback()
                    cancelled = False
                if cancelled:
                    cancel_seen = cancel_seen or time.monotonic()
                    if time.monotonic() - cancel_seen > self.settings.job_cancel_grace_seconds:
                        outcome = "cancel_forced"
                        child.kill()
                        child.join(10)
                        break
                if time.monotonic() - started > timeout:
                    outcome = "timeout"
                    child.kill()
                    child.join(10)
                    break
            self._finalize(session, job_id, outcome, child.exitcode, timeout)
            return job_id
        finally:
            session.close()

    def _finalize(self, session, job_id: int, outcome: str, exitcode: int | None, timeout: float) -> None:  # type: ignore[no-untyped-def]
        job = session.get(Job, job_id, populate_existing=True)
        if job is None or job.status != "running":
            return  # the child finished the job itself
        if outcome == "shutdown":
            job.status, job.stage, job.message = "queued", "requeued", "Worker shut down while the job was running; requeued"
            job.worker_id, job.lease_expires_at = None, None
            session.commit()
            return
        if outcome == "timeout":
            jobstore.finish_job(session, job_id, "failed", error_code="timeout", error_message=f"Job exceeded {timeout:.0f}s and was terminated")
        elif outcome == "cancel_forced":
            jobstore.finish_job(session, job_id, "cancelled", error_code="cancelled", error_message="Cancelled; worker terminated the job process")
        else:
            jobstore.finish_job(
                session,
                job_id,
                "failed",
                error_code="worker_crash",
                error_message=f"Job process exited with code {exitcode} without completing the job ({datetime.now(UTC).isoformat()})",
            )


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    settings.ensure_dirs()
    init_engine(settings.resolved_database_url)
    sup = Supervisor(settings)
    signal.signal(signal.SIGINT, sup.request_stop)
    signal.signal(signal.SIGTERM, sup.request_stop)
    if sys.platform == "win32" and hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, sup.request_stop)
    sup.run_forever()


if __name__ == "__main__":
    main()
