"""Lifecycle of the OpenCode runtime used by the backend.

In ``managed`` mode the backend starts a private ``opencode serve`` bound to 127.0.0.1
with a random per-process password, from an empty sandbox working directory.
In ``external`` mode it connects to a configured server URL.
"""

from __future__ import annotations

import os
import secrets
import shutil
import subprocess
import sys
import threading
import time

from app.agents.opencode_adapter import OpenCodeAdapter, RuntimeInfo
from app.core.config import Settings
from app.core.isolation import JobObject, Limits, popen_limited
from app.core.logging import get_logger

log = get_logger(__name__)


class OpenCodeRuntime:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.cfg = settings.opencode
        self._proc: subprocess.Popen[bytes] | None = None
        self._job: JobObject | None = None
        self._password: str | None = None
        self._lock = threading.Lock()
        self.last_error: str | None = None

    @property
    def enabled(self) -> bool:
        return self.cfg.mode in ("managed", "external")

    def adapter(self, timeout: float | None = None) -> OpenCodeAdapter:
        if self.cfg.mode == "managed":
            self.ensure_started()
            base = f"http://127.0.0.1:{self.cfg.port}"
            password = self._password
        else:
            base = self.cfg.base_url
            password = self.cfg.password.get_secret_value() if self.cfg.password else None
        return OpenCodeAdapter(base, self.cfg.username, password, timeout=timeout or self.cfg.request_timeout_seconds)

    def ensure_started(self) -> None:
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                return
            exe = shutil.which(self.cfg.executable)
            if exe is None:
                self.last_error = f"OpenCode executable '{self.cfg.executable}' not found on PATH"
                return
            self._password = secrets.token_urlsafe(32)
            workdir = self.settings.opencode_workdir
            workdir.mkdir(parents=True, exist_ok=True)
            env = dict(os.environ)
            env["OPENCODE_SERVER_PASSWORD"] = self._password
            creationflags = 0
            if sys.platform == "win32":
                creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0)
            cmd = [exe, "serve", "--hostname", "127.0.0.1", "--port", str(self.cfg.port)]
            log.info("starting managed OpenCode runtime on 127.0.0.1:%s", self.cfg.port)
            # Kill-on-close job: if the backend dies, the OpenCode server dies with it (no orphan with a live password).
            self._proc, self._job = popen_limited(
                cmd,
                Limits(kill_on_close=True),
                cwd=str(workdir),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=creationflags,
            )
            deadline = time.monotonic() + self.cfg.startup_timeout_seconds
            probe = OpenCodeAdapter(f"http://127.0.0.1:{self.cfg.port}", self.cfg.username, self._password, timeout=3)
            try:
                while time.monotonic() < deadline:
                    if self._proc.poll() is not None:
                        self.last_error = f"OpenCode exited during startup (code {self._proc.returncode}); is port {self.cfg.port} in use?"
                        self._proc = None
                        return
                    if probe.runtime_info().available:
                        self.last_error = None
                        return
                    time.sleep(0.5)
                self.last_error = "OpenCode did not become ready before the startup timeout"
            finally:
                probe.close()

    def status(self) -> RuntimeInfo:
        if not self.enabled:
            return RuntimeInfo(available=False, error="Agent runtime disabled by configuration (IP_OPENCODE_MODE=disabled)")
        adapter = self.adapter(timeout=5)
        try:
            info = adapter.runtime_info()
        finally:
            adapter.close()
        if not info.available and self.last_error:
            info.error = self.last_error
        return info

    def connection(self) -> tuple[str, str | None] | None:
        """(base_url, password) of a running managed server, for handing to the worker subprocess."""
        if self.cfg.mode == "managed" and self._proc is not None and self._proc.poll() is None:
            return f"http://127.0.0.1:{self.cfg.port}", self._password
        if self.cfg.mode == "external":
            return self.cfg.base_url, self.cfg.password.get_secret_value() if self.cfg.password else None
        return None

    def stop(self) -> None:
        with self._lock:
            proc, self._proc = self._proc, None
            job, self._job = self._job, None
        if job is not None:
            job.close()
        if proc is None or proc.poll() is not None:
            return
        try:
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            else:
                proc.terminate()
            proc.wait(timeout=10)
        except Exception:  # pragma: no cover
            proc.kill()
