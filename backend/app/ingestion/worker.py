"""In-process background worker. Claims jobs atomically; renews its lease while running."""

from __future__ import annotations

import threading
import uuid

from app.agents.runtime import OpenCodeRuntime
from app.agents.service import run_agent_job, run_qa_job
from app.core.config import Settings
from app.core.logging import get_logger
from app.database.engine import session_factory
from app.database.models import Job
from app.ingestion import jobs as jobstore
from app.ingestion.pipeline import IngestionPipeline, run_ingest

log = get_logger(__name__)


class Worker:
    def __init__(self, settings: Settings, runtime: OpenCodeRuntime, pipeline: IngestionPipeline | None = None) -> None:
        self.settings = settings
        self.runtime = runtime
        self.pipeline = pipeline or IngestionPipeline(settings)
        self.worker_id = f"worker-{uuid.uuid4().hex[:10]}"
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name=self.worker_id, daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout)

    def run_once(self) -> int | None:
        """Claim and run at most one job. Returns the job id or None."""
        session = session_factory()()
        try:
            jobstore.recover_stale_jobs(session)
            job_id = jobstore.claim_next_job(session, self.worker_id, self.settings.job_lease_seconds)
            if job_id is None:
                return None
            hb_stop = threading.Event()
            hb = threading.Thread(target=self._heartbeat, args=(job_id, hb_stop), daemon=True)
            hb.start()
            try:
                job = session.get(Job, job_id)
                assert job is not None
                if job.kind == "ingest":
                    run_ingest(session, self.pipeline, job_id)
                elif job.kind == "agent_report":
                    run_agent_job(session, self.runtime, job_id)
                elif job.kind == "qa":
                    run_qa_job(session, self.runtime, job_id)
                else:
                    jobstore.finish_job(session, job_id, "failed", error_code="unknown_job_kind", error_message=job.kind)
            finally:
                hb_stop.set()
                hb.join(2)
            return job_id
        finally:
            session.close()

    def _heartbeat(self, job_id: int, stop: threading.Event) -> None:
        interval = max(1.0, self.settings.job_lease_seconds / 3)
        while not stop.wait(interval):
            s = session_factory()()
            try:
                jobstore.heartbeat(s, job_id, self.worker_id, self.settings.job_lease_seconds)
            except Exception:  # pragma: no cover - heartbeat is best effort
                log.warning("heartbeat failed for job %s", job_id)
            finally:
                s.close()

    def _loop(self) -> None:
        log.info("worker %s started", self.worker_id)
        while not self._stop.is_set():
            try:
                ran = self.run_once()
            except Exception:
                log.exception("worker loop error")
                ran = None
            if ran is None:
                self._stop.wait(self.settings.worker_poll_seconds)
