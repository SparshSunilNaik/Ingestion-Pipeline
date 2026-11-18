"""Local-first authentication.

* A random API token is generated on first start and stored in `<data_dir>/api-token` with an
  ACL restricted to the current user. It is never returned by the API or written to logs.
* Programmatic clients send `Authorization: Bearer <token>`.
* Browsers exchange the token once (`POST /api/auth/login`) for a server-side session. The
  cookie is HttpOnly + SameSite=Strict; only a SHA-256 of the session secret is stored.
* Cookie-authenticated state-changing requests must also send `X-IP-CSRF: 1` (a header a
  cross-site form cannot set), in addition to SameSite=Strict.
* Every endpoint except health and the auth endpoints requires authentication.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi import Request
from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.errors import AppError
from app.core.isolation import restrict_to_current_user
from app.database.models import ApiSession

COOKIE = "ip_session"
CSRF_HEADER = "x-ip-csrf"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


class Unauthorized(AppError):
    status_code = 401
    code = "unauthorized"


class Forbidden(AppError):
    status_code = 403
    code = "forbidden"


class TooManyRequests(AppError):
    status_code = 429
    code = "too_many_requests"


def token_path(settings: Settings) -> Path:
    return settings.data_dir / "api-token"


def ensure_token(settings: Settings) -> str:
    path = token_path(settings)
    if settings.api_token:
        return settings.api_token.get_secret_value()
    if path.exists():
        token = path.read_text(encoding="utf-8").strip()
        if len(token) >= 32:
            return token
    token = secrets.token_urlsafe(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(token, encoding="utf-8")
    restrict_to_current_user(path)
    return token


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


class LoginLimiter:
    """At most `limit` failed logins per client per window."""

    def __init__(self, limit: int = 5, window_seconds: float = 60.0) -> None:
        self.limit = limit
        self.window = window_seconds
        self.failures: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, client: str) -> None:
        now = time.monotonic()
        with self._lock:
            q = self.failures[client]
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                raise TooManyRequests("Too many failed login attempts; try again later")

    def fail(self, client: str) -> None:
        with self._lock:
            self.failures[client].append(time.monotonic())


class Authenticator:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.enabled = settings.auth_mode == "token"
        self.token = ensure_token(settings) if self.enabled else ""
        self.limiter = LoginLimiter()

    def token_ok(self, candidate: str) -> bool:
        return bool(candidate) and hmac.compare_digest(candidate.encode(), self.token.encode())

    def create_session(self, db: Session) -> tuple[str, datetime]:
        secret = secrets.token_urlsafe(32)
        expires = datetime.now(UTC) + timedelta(hours=self.settings.session_ttl_hours)
        db.execute(delete(ApiSession).where(ApiSession.expires_at < datetime.now(UTC)))
        db.add(ApiSession(id_hash=_hash(secret), expires_at=expires))
        db.commit()
        return secret, expires

    def drop_session(self, db: Session, secret: str | None) -> None:
        if secret:
            db.execute(delete(ApiSession).where(ApiSession.id_hash == _hash(secret)))
            db.commit()

    def session_valid(self, db: Session, secret: str | None) -> bool:
        if not secret:
            return False
        row = db.get(ApiSession, _hash(secret))
        if row is None:
            return False
        now = datetime.now(UTC)
        if row.expires_at < now:
            db.delete(row)
            db.commit()
            return False
        if (now - row.last_seen_at).total_seconds() > 60:
            row.last_seen_at = now
            db.commit()
        return True

    def authenticate(self, request: Request, db: Session) -> str:
        """Returns the auth method used ('disabled', 'bearer', 'session') or raises."""
        if not self.enabled:
            return "disabled"
        header = request.headers.get("authorization", "")
        if header.lower().startswith("bearer "):
            if self.token_ok(header[7:].strip()):
                return "bearer"
            raise Unauthorized("Invalid API token")
        if self.session_valid(db, request.cookies.get(COOKIE)):
            if request.method not in SAFE_METHODS and request.headers.get(CSRF_HEADER) != "1":
                raise Forbidden("Missing CSRF header for a cookie-authenticated request")
            return "session"
        raise Unauthorized("Authentication required")
