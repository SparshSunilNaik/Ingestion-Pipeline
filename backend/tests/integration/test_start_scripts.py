"""Smoke test: scripts/start-backend.ps1 starts a working API and keeps it running with captured output.

The owner-visible "500 Internal Server Error" happened when the backend was not running while the frontend
was (see docs/TROUBLESHOOTING.md). This test guards the documented way of starting the backend. It runs the
real script with its output captured, against an isolated data directory (no user data is touched).
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

from app.core.config import BACKEND_ROOT

pytestmark = pytest.mark.skipif(sys.platform != "win32" or shutil.which("powershell") is None, reason="Windows PowerShell script")

SCRIPT = BACKEND_ROOT.parent / "scripts" / "start-backend.ps1"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _healthy(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2) as r:
            return r.status == 200
    except OSError:
        return False


def test_start_backend_script_survives_captured_output(tmp_path: Path) -> None:
    port = _free_port()
    log = tmp_path / "start.log"
    env = {
        **os.environ,
        "IP_DATA_DIR": str(tmp_path / "data"),
        "IP_API_TOKEN": "start-script-test-token-0000000000000000",
        "IP_OPENCODE_MODE": "disabled",
        "IP_WORKER_MODE": "none",
    }
    # Output captured inside PowerShell, as when started from a terminal tab, a job or a log file.
    command = f"& '{SCRIPT}' -Port {port} *>&1 | Out-File -FilePath '{log}' -Encoding utf8"
    proc = subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], env=env)
    try:
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline and not _healthy(port):
            assert proc.poll() is None, f"start-backend.ps1 exited early:\n{log.read_text(encoding='utf-8', errors='replace') if log.exists() else ''}"
            time.sleep(1)
        assert _healthy(port), "backend did not become healthy"
        time.sleep(3)  # it must keep running after startup logging
        assert proc.poll() is None and _healthy(port)
    finally:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True, check=False)
        # uv's child interpreter can outlive the PowerShell parent; stop whatever still listens on the test port.
        stop_listener = f"Get-NetTCPConnection -State Listen -LocalPort {port} -ErrorAction SilentlyContinue | ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force }}"
        subprocess.run(["powershell", "-NoProfile", "-Command", stop_listener], capture_output=True, check=False)
