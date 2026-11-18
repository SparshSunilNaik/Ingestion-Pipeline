import os
import subprocess
import sys
import time

import pytest
from fastapi.testclient import TestClient

from app.core.auth import COOKIE, token_path
from app.core.isolation import IS_WINDOWS, Limits, is_process_in_any_job, popen_limited
from app.main import create_app


@pytest.fixture
def app(settings):
    return create_app(settings)


def test_token_file_created_and_restricted(app, settings) -> None:
    path = token_path(settings)
    assert path.exists() and len(path.read_text().strip()) >= 32
    if IS_WINDOWS:
        acl = subprocess.run(["icacls", str(path)], capture_output=True, text=True).stdout
        assert "(I)" not in acl  # inheritance removed
        assert os.environ["USERNAME"].lower() in acl.lower()
        assert "Everyone" not in acl and "BUILTIN\\Users" not in acl
    else:
        assert (path.stat().st_mode & 0o077) == 0


def test_endpoints_require_authentication(app) -> None:
    with TestClient(app) as c:
        assert c.get("/api/health").status_code == 200
        assert c.get("/api/auth/status").json()["authenticated"] is False
        for method, url in [("GET", "/api/repositories"), ("GET", "/api/jobs"), ("POST", "/api/jobs"), ("GET", "/api/agent/status"), ("GET", "/openapi.json")]:
            r = c.request(method, url, json={"url": "https://github.com/a/b"} if method == "POST" else None)
            if url == "/openapi.json":
                assert r.status_code == 200  # schema only, no data
            else:
                assert r.status_code == 401, url
                assert r.json()["error"]["code"] == "unauthorized"
        assert c.get("/api/repositories", headers={"Authorization": "Bearer wrong"}).status_code == 401
        token = app.state.auth.token
        assert c.get("/api/repositories", headers={"Authorization": f"Bearer {token}"}).status_code == 200


def test_cookie_session_and_csrf(app) -> None:
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"token": "nope"}).status_code == 401
        r = c.post("/api/auth/login", json={"token": app.state.auth.token})
        assert r.status_code == 200
        cookie = r.headers["set-cookie"]
        assert "HttpOnly" in cookie and "SameSite=strict" in cookie.replace("Strict", "strict")
        assert c.get("/api/repositories").status_code == 200  # cookie session
        assert c.get("/api/auth/status").json()["method"] == "session"
        # cookie-authenticated mutation without the CSRF header is refused
        assert c.post("/api/jobs", json={"url": "https://github.com/a/b"}).status_code == 403
        ok = c.post("/api/jobs", json={"url": "https://github.com/a/b"}, headers={"X-IP-CSRF": "1"})
        assert ok.status_code == 202
        c.post("/api/auth/logout", headers={"X-IP-CSRF": "1"})
        c.cookies.clear()
        assert c.get("/api/repositories").status_code == 401


def test_session_secret_not_stored_in_plaintext(app, session) -> None:
    from app.database.models import ApiSession

    with TestClient(app) as c:
        c.post("/api/auth/login", json={"token": app.state.auth.token})
        secret = c.cookies.get(COOKIE)
    rows = session.query(ApiSession).all()
    assert rows and all(r.id_hash != secret and len(r.id_hash) == 64 for r in rows)


def test_login_rate_limit(app) -> None:
    with TestClient(app) as c:
        codes = [c.post("/api/auth/login", json={"token": f"bad{i}"}).status_code for i in range(7)]
    assert codes[:5] == [401] * 5 and codes[5] == 429


def test_untrusted_host_and_large_bodies_rejected(app) -> None:
    token = app.state.auth.token
    with TestClient(app, headers={"Authorization": f"Bearer {token}"}) as c:
        assert c.get("/api/health", headers={"Host": "evil.example.com"}).status_code == 400  # DNS rebinding defence
        big = "x" * (300 * 1024)
        assert c.post("/api/jobs", content='{"url": "' + big + '"}', headers={"content-type": "application/json"}).status_code == 413


@pytest.mark.skipif(not IS_WINDOWS, reason="Windows Job Object behaviour")
def test_job_object_limits_enforced() -> None:
    proc, job = popen_limited([sys.executable, "-c", "import time; time.sleep(30)"], Limits(memory_bytes=256 * 1024 * 1024, max_processes=2))
    assert is_process_in_any_job(proc.pid) is True
    limits = job.query_limits()
    assert limits["process_memory_limit"] == 256 * 1024 * 1024 and limits["active_process_limit"] == 2
    start = time.monotonic()
    job.close()  # kill-on-close
    proc.wait(10)
    assert time.monotonic() - start < 5
    p2, j2 = popen_limited([sys.executable, "-c", "b = bytearray(600 * 1024 * 1024)"], Limits(memory_bytes=200 * 1024 * 1024), stderr=subprocess.PIPE)
    _, err = p2.communicate(timeout=60)
    j2.close()
    assert p2.returncode != 0 and b"MemoryError" in err


def test_git_runs_inside_limits(tmp_path) -> None:
    from app.ingestion.git_ops import GitRunner

    r = GitRunner(tmp_path / "sb", limits=Limits(memory_bytes=512 * 1024 * 1024, max_processes=8))
    res = r.run(["--version"], cwd=None, timeout=30)
    assert res.returncode == 0 and "git version" in res.stdout
