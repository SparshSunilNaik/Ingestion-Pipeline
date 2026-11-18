"""FastAPI application factory."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.agents.runtime import OpenCodeRuntime
from app.api import intel
from app.api.routes import VERSION, public, router
from app.core.auth import Authenticator, token_path
from app.core.config import BACKEND_ROOT, Settings, get_settings
from app.core.errors import install_error_handlers
from app.core.isolation import JobObject, Limits, popen_limited
from app.core.logging import configure_logging, get_logger
from app.database.engine import init_engine
from app.database.migrate import upgrade_database
from app.ingestion.pipeline import IngestionPipeline
from app.ingestion.worker import Worker

log = get_logger(__name__)


class WorkerProcess:
    """Supervises `python -m app.worker_main` as a separate process (kill-on-close job on Windows)."""

    def __init__(self, settings: Settings, runtime: OpenCodeRuntime) -> None:
        self.settings = settings
        self.runtime = runtime
        self.proc: subprocess.Popen[bytes] | None = None
        self.job: JobObject | None = None
        self.restarts = 0
        self._stopping = threading.Event()
        self._watchdog: threading.Thread | None = None

    def start(self) -> None:
        env = dict(os.environ)
        env["IP_DATA_DIR"] = str(self.settings.data_dir)
        if self.settings.database_url:
            env["IP_DATABASE_URL"] = self.settings.database_url
        conn = self.runtime.connection() if self.runtime.enabled else None
        if self.runtime.enabled and conn is None and self.settings.opencode.mode == "managed":
            self.runtime.ensure_started()
            conn = self.runtime.connection()
        if conn is not None:
            # The worker talks to the API's OpenCode server; credentials travel only via this child's environment.
            env["IP_OPENCODE_MODE"] = "external"
            env["IP_OPENCODE_BASE_URL"] = conn[0]
            env["IP_OPENCODE_PASSWORD"] = conn[1] or ""
        elif not self.runtime.enabled or self.settings.opencode.mode == "managed":
            env["IP_OPENCODE_MODE"] = "disabled"
        flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        self.proc, self.job = popen_limited(
            [sys.executable, "-m", "app.worker_main"], Limits(kill_on_close=True), cwd=str(BACKEND_ROOT), env=env, creationflags=flags
        )
        log.info("worker process started (pid %s)", self.proc.pid)
        if self._watchdog is None:
            self._watchdog = threading.Thread(target=self._watch, name="worker-watchdog", daemon=True)
            self._watchdog.start()

    def _watch(self) -> None:
        """Restart the worker if it exits unexpectedly (bounded, with backoff)."""
        while not self._stopping.wait(2.0):
            proc = self.proc
            if proc is not None and proc.poll() is not None and not self._stopping.is_set():
                if self.restarts >= 5:
                    log.error("worker process exited (code %s); restart limit reached", proc.returncode)
                    return
                self.restarts += 1
                log.warning("worker process exited (code %s); restarting (%s/5)", proc.returncode, self.restarts)
                if self.job is not None:
                    self.job.close()
                time.sleep(min(30, 2**self.restarts))
                if not self._stopping.is_set():
                    self.start()

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def stop(self, grace: float = 20.0) -> None:
        self._stopping.set()
        if self.proc is None:
            return
        if self.proc.poll() is None:
            try:
                if sys.platform == "win32":
                    self.proc.send_signal(signal.CTRL_BREAK_EVENT)
                else:
                    self.proc.terminate()
                self.proc.wait(grace)
            except Exception:
                log.warning("worker did not stop within %ss; terminating", grace)
        if self.job is not None:
            self.job.close()  # kills anything left (worker, job children, git)
        elif self.proc.poll() is None:
            self.proc.kill()
        self.proc = None


def create_app(settings: Settings | None = None, pipeline: IngestionPipeline | None = None, runtime: OpenCodeRuntime | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_json)
    settings.ensure_dirs()
    url = settings.resolved_database_url
    upgrade_database(url)
    init_engine(url)
    runtime = runtime or OpenCodeRuntime(settings)
    auth = Authenticator(settings)
    mode = settings.worker_mode if settings.start_worker else "none"

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        worker = None
        proc = None
        if mode == "inprocess":
            worker = Worker(settings, runtime, pipeline)
            worker.start()
        elif mode == "subprocess":
            proc = WorkerProcess(settings, runtime)
            proc.start()
        app.state.worker = worker
        app.state.worker_process = proc
        if auth.enabled:
            log.info("API token file: %s", token_path(settings))
        yield
        if worker:
            worker.stop()
        if proc:
            proc.stop()
        runtime.stop()

    app = FastAPI(
        title="Ingestion-Pipeline API",
        version=VERSION,
        lifespan=lifespan,
        description="Evidence-grounded repository intelligence. All analysis is static; repository code is never executed. "
        "All endpoints except /api/health* and /api/auth/* require `Authorization: Bearer <token>` or a session cookie.",
    )
    app.state.settings = settings
    app.state.runtime = runtime
    app.state.auth = auth
    app.state.worker = None
    app.state.worker_process = None
    app.state.worker_mode = mode

    @app.middleware("http")
    async def limit_request_size(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        length = request.headers.get("content-length")
        if length is not None and (not length.isdigit() or int(length) > settings.max_request_bytes):
            return JSONResponse(status_code=413, content={"error": {"code": "request_too_large", "message": "Request body too large", "details": {}}})
        if request.method in ("POST", "PUT", "PATCH") and length is None and request.headers.get("transfer-encoding"):
            return JSONResponse(status_code=411, content={"error": {"code": "length_required", "message": "Content-Length required", "details": {}}})
        return await call_next(request)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "PUT"],
        allow_headers=["content-type", "authorization", "x-ip-csrf"],
        allow_credentials=True,
    )
    # Rejects requests whose Host header is not local (DNS-rebinding protection for a localhost service).
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
    install_error_handlers(app)
    app.include_router(public)
    app.include_router(intel.public)
    app.include_router(router)
    app.include_router(intel.router)
    return app


def app_factory() -> FastAPI:
    return create_app()
