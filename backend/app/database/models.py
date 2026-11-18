"""ORM models. Schema changes must go through Alembic migrations."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, ClassVar

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator


def utcnow() -> datetime:
    return datetime.now(UTC)


class UTCDateTime(TypeDecorator[datetime]):
    """Stores UTC datetimes; always returns timezone-aware values (SQLite drops tzinfo)."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC).replace(tzinfo=None)

    def process_result_value(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value


class Base(DeclarativeBase):
    type_annotation_map: ClassVar[dict[Any, Any]] = {dict[str, Any]: JSON, list[Any]: JSON}


class Repository(Base):
    __tablename__ = "repositories"
    __table_args__ = (UniqueConstraint("owner", "name", name="uq_repo_owner_name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner: Mapped[str] = mapped_column(String(100))
    name: Mapped[str] = mapped_column(String(100))
    canonical_url: Mapped[str] = mapped_column(String(300))
    default_branch: Mapped[str | None] = mapped_column(String(255))
    current_snapshot_id: Mapped[int | None] = mapped_column(ForeignKey("snapshots.id", use_alter=True, name="fk_repo_current_snapshot", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)

    snapshots: Mapped[list[Snapshot]] = relationship(back_populates="repository", foreign_keys="Snapshot.repository_id", cascade="all, delete-orphan")


class Snapshot(Base):
    """An immutable, analysed checkout of one exact commit."""

    __tablename__ = "snapshots"
    __table_args__ = (UniqueConstraint("repository_id", "commit_sha", "analyzer_version", name="uq_snapshot_commit_version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    repository_id: Mapped[int] = mapped_column(ForeignKey("repositories.id", ondelete="CASCADE"), index=True)
    commit_sha: Mapped[str] = mapped_column(String(64))
    default_branch: Mapped[str | None] = mapped_column(String(255))
    storage_path: Mapped[str] = mapped_column(String(1000))
    status: Mapped[str] = mapped_column(String(32), default="pending")  # pending|ready|failed
    analyzer_version: Mapped[str] = mapped_column(String(32))
    acquired_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    commit_info: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    recent_commits: Mapped[list[Any]] = mapped_column(JSON, default=list)
    coverage: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    inventory_summary: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    analysis_summary: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)

    repository: Mapped[Repository] = relationship(back_populates="snapshots", foreign_keys=[repository_id])


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (Index("ix_jobs_status_created", "status", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(32), default="ingest")  # ingest|agent_report
    repository_id: Mapped[int | None] = mapped_column(ForeignKey("repositories.id", ondelete="CASCADE"))
    snapshot_id: Mapped[int | None] = mapped_column(ForeignKey("snapshots.id", ondelete="SET NULL"))
    requested_url: Mapped[str] = mapped_column(String(500))
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(32), default="queued")
    stage: Mapped[str] = mapped_column(String(64), default="queued")
    progress: Mapped[int] = mapped_column(Integer, default=0)
    message: Mapped[str | None] = mapped_column(Text)
    error_code: Mapped[str | None] = mapped_column(String(64))
    error_message: Mapped[str | None] = mapped_column(Text)
    worker_id: Mapped[str | None] = mapped_column(String(64))
    lease_expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    reused_cache: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class FileRecord(Base):
    __tablename__ = "files"
    __table_args__ = (UniqueConstraint("snapshot_id", "path", name="uq_file_path"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshots.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(String(1000))
    size: Mapped[int] = mapped_column(Integer, default=0)
    extension: Mapped[str] = mapped_column(String(32), default="")
    language: Mapped[str | None] = mapped_column(String(32))
    category: Mapped[str] = mapped_column(String(32))
    is_text: Mapped[bool] = mapped_column(Boolean, default=False)
    analyzed: Mapped[bool] = mapped_column(Boolean, default=False)
    exclusion_reason: Mapped[str | None] = mapped_column(String(64))
    line_count: Mapped[int | None] = mapped_column(Integer)
    sha256: Mapped[str | None] = mapped_column(String(64))


class Symbol(Base):
    __tablename__ = "symbols"
    __table_args__ = (Index("ix_symbols_snapshot_name", "snapshot_id", "name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshots.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(String(1000))
    kind: Mapped[str] = mapped_column(String(32))  # function|class|method|variable
    name: Mapped[str] = mapped_column(String(300))
    qualified_name: Mapped[str] = mapped_column(String(600))
    start_line: Mapped[int] = mapped_column(Integer)
    end_line: Mapped[int] = mapped_column(Integer)
    exported: Mapped[bool] = mapped_column(Boolean, default=False)
    signature: Mapped[str | None] = mapped_column(Text)
    docstring: Mapped[str | None] = mapped_column(Text)
    evidence_id: Mapped[str | None] = mapped_column(String(40))


class Evidence(Base):
    __tablename__ = "evidence"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshots.id", ondelete="CASCADE"), index=True)
    repository_id: Mapped[int] = mapped_column(ForeignKey("repositories.id", ondelete="CASCADE"))
    commit_sha: Mapped[str] = mapped_column(String(64))
    path: Mapped[str] = mapped_column(String(1000))
    start_line: Mapped[int] = mapped_column(Integer)
    end_line: Mapped[int] = mapped_column(Integer)
    category: Mapped[str] = mapped_column(String(48))
    subject: Mapped[str | None] = mapped_column(String(600))
    extraction_method: Mapped[str] = mapped_column(String(48))
    analyzer_version: Mapped[str] = mapped_column(String(32))
    contract_version: Mapped[str] = mapped_column(String(16))
    verification_status: Mapped[str] = mapped_column(String(32))
    source_kind: Mapped[str] = mapped_column(String(32))  # source|documentation|configuration|manifest|test
    limitations: Mapped[list[Any]] = mapped_column(JSON, default=list)
    excerpt_sha256: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class GraphNode(Base):
    __tablename__ = "graph_nodes"
    __table_args__ = (UniqueConstraint("snapshot_id", "key", name="uq_node_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshots.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(1200))
    kind: Mapped[str] = mapped_column(String(32))
    label: Mapped[str] = mapped_column(String(600))
    path: Mapped[str | None] = mapped_column(String(1000))
    start_line: Mapped[int | None] = mapped_column(Integer)
    end_line: Mapped[int | None] = mapped_column(Integer)
    attrs: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class GraphEdge(Base):
    __tablename__ = "graph_edges"
    __table_args__ = (Index("ix_edges_snapshot_kind", "snapshot_id", "kind"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshots.id", ondelete="CASCADE"), index=True)
    source_key: Mapped[str] = mapped_column(String(1200))
    target_key: Mapped[str] = mapped_column(String(1200))
    kind: Mapped[str] = mapped_column(String(32))
    resolution: Mapped[str] = mapped_column(String(32))  # resolved|external|ambiguous|unresolved
    evidence_id: Mapped[str | None] = mapped_column(String(40))
    attrs: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class Dependency(Base):
    __tablename__ = "dependencies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshots.id", ondelete="CASCADE"), index=True)
    ecosystem: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(300))
    specifier: Mapped[str | None] = mapped_column(String(300))
    scope: Mapped[str] = mapped_column(String(32))  # runtime|dev|optional|undeclared
    manifest_path: Mapped[str | None] = mapped_column(String(1000))
    status: Mapped[str] = mapped_column(String(32))  # observed_import|not_observed|undeclared_import
    evidence_id: Mapped[str | None] = mapped_column(String(40))
    import_count: Mapped[int] = mapped_column(Integer, default=0)


class Finding(Base):
    """Framework/route/entry-point style findings produced by deterministic analysis."""

    __tablename__ = "findings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshots.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(32))  # framework|route|entry_point|test_suite|ci|container
    name: Mapped[str] = mapped_column(String(600))
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    evidence_id: Mapped[str | None] = mapped_column(String(40))
    confidence: Mapped[str] = mapped_column(String(16), default="confirmed")


class Report(Base):
    __tablename__ = "reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshots.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(32))  # deterministic|agent
    status: Mapped[str] = mapped_column(String(32))  # complete|failed|partial
    model: Mapped[str | None] = mapped_column(String(200))
    content: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    markdown: Mapped[str] = mapped_column(Text, default="")
    usage: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)


class FileAnalysisCache(Base):
    """Per-file parse result (language IR) keyed by content hash; enables incremental refresh."""

    __tablename__ = "file_analyses"
    __table_args__ = (UniqueConstraint("snapshot_id", "path", name="uq_file_analysis_path"), Index("ix_file_analyses_sha", "sha256", "analyzer_version"))

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshots.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(String(1000))
    sha256: Mapped[str] = mapped_column(String(64))
    analyzer_version: Mapped[str] = mapped_column(String(32))
    language: Mapped[str] = mapped_column(String(32))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class Conversation(Base):
    """A repository Q&A session, pinned to exactly one snapshot (commit)."""

    __tablename__ = "conversations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshots.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(300))
    model: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16))  # user|assistant
    content: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="complete")  # pending|complete|failed|cancelled
    job_id: Mapped[int | None] = mapped_column(ForeignKey("jobs.id", ondelete="SET NULL"))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # claims, limitations, retrieval, usage
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class ApiSession(Base):
    """Server-side browser session; only a SHA-256 of the session secret is stored."""

    __tablename__ = "api_sessions"

    id_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
    last_seen_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
