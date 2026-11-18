"""SQLite engine with WAL, foreign keys and busy timeout."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

_engine: Engine | None = None
_factory: sessionmaker[Session] | None = None


def _sqlite_pragmas(dbapi_conn: Any, _record: Any) -> None:
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA busy_timeout=10000")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.close()


def make_engine(url: str) -> Engine:
    engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 30}, future=True)
    if url.startswith("sqlite"):
        event.listen(engine, "connect", _sqlite_pragmas)
    return engine


def init_engine(url: str) -> Engine:
    global _engine, _factory
    if _engine is not None:
        _engine.dispose()
    _engine = make_engine(url)
    _factory = sessionmaker(bind=_engine, expire_on_commit=False)
    return _engine


def get_engine() -> Engine:
    if _engine is None:
        raise RuntimeError("database engine not initialised")
    return _engine


def session_factory() -> sessionmaker[Session]:
    if _factory is None:
        raise RuntimeError("database engine not initialised")
    return _factory


@contextmanager
def session_scope() -> Iterator[Session]:
    session = session_factory()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_db() -> Iterator[Session]:
    """FastAPI dependency."""
    session = session_factory()()
    try:
        yield session
    finally:
        session.close()
