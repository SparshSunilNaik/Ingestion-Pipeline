"""Typed API contracts."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class HealthOut(BaseModel):
    status: str
    app: str
    version: str


class ReadinessOut(BaseModel):
    status: str
    database: bool
    git: str | None
    worker_running: bool
    agent: dict[str, Any]


class UrlIn(BaseModel):
    url: str = Field(max_length=500)


class UrlValidationOut(BaseModel):
    valid: bool
    canonical_url: str | None = None
    owner: str | None = None
    name: str | None = None
    error: str | None = None


class JobOut(ORM):
    id: int
    kind: str
    repository_id: int | None
    snapshot_id: int | None
    requested_url: str
    status: str
    stage: str
    progress: int
    message: str | None
    error_code: str | None
    error_message: str | None
    attempts: int
    reused_cache: bool
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    params: dict[str, Any]


class JobCreatedOut(BaseModel):
    job: JobOut
    created: bool


class SnapshotBrief(ORM):
    id: int
    commit_sha: str
    status: str
    default_branch: str | None
    acquired_at: datetime
    analyzer_version: str


class RepositoryOut(ORM):
    id: int
    owner: str
    name: str
    canonical_url: str
    default_branch: str | None
    current_snapshot_id: int | None
    created_at: datetime
    updated_at: datetime


class RepositoryDetailOut(RepositoryOut):
    snapshots: list[SnapshotBrief]
    current: SnapshotBrief | None = None
    latest_job: JobOut | None = None


class SnapshotOut(ORM):
    id: int
    repository_id: int
    commit_sha: str
    default_branch: str | None
    status: str
    analyzer_version: str
    acquired_at: datetime
    commit_info: dict[str, Any]
    recent_commits: list[Any]
    coverage: dict[str, Any]
    inventory_summary: dict[str, Any]
    analysis_summary: dict[str, Any]
    repository: RepositoryOut


class FileOut(ORM):
    path: str
    size: int
    extension: str
    language: str | None
    category: str
    is_text: bool
    analyzed: bool
    exclusion_reason: str | None
    line_count: int | None


class Page[T](BaseModel):
    total: int
    items: list[T]


class SourceOut(BaseModel):
    path: str
    start_line: int
    end_line: int
    total_lines: int
    language: str | None
    lines: list[str]


class SymbolOut(ORM):
    id: int
    path: str
    kind: str
    name: str
    qualified_name: str
    start_line: int
    end_line: int
    exported: bool
    signature: str | None
    docstring: str | None
    evidence_id: str | None


class EvidenceOut(ORM):
    id: str
    repository_id: int
    snapshot_id: int
    commit_sha: str
    path: str
    start_line: int
    end_line: int
    category: str
    subject: str | None
    extraction_method: str
    analyzer_version: str
    contract_version: str
    verification_status: str
    source_kind: str
    limitations: list[Any]


class EvidenceDetailOut(EvidenceOut):
    verified_now: bool
    verification_reason: str | None
    excerpt: str | None


class LocationIn(BaseModel):
    path: str = Field(max_length=1000)
    start_line: int
    end_line: int


class LocationVerificationOut(BaseModel):
    ok: bool
    reason: str | None


class GraphNodeOut(BaseModel):
    key: str
    kind: str
    label: str
    path: str | None
    start_line: int | None
    end_line: int | None
    attrs: dict[str, Any]


class GraphEdgeOut(BaseModel):
    source: str
    target: str
    kind: str
    resolution: str
    evidence_id: str | None
    count: int


class GraphOut(BaseModel):
    view: str
    nodes: list[GraphNodeOut]
    edges: list[GraphEdgeOut]
    truncated: bool
    totals: dict[str, int]


class ImpactItem(BaseModel):
    key: str
    kind: str | None
    label: str | None
    depth: int
    via: str


class ImpactOut(BaseModel):
    key: str
    dependents: list[ImpactItem]
    truncated: bool
    note: str
    direct_dependents: list[dict[str, Any]] = Field(default_factory=list)
    transitive_dependents: list[dict[str, Any]] = Field(default_factory=list)
    potentially_affected_routes: list[dict[str, Any]] = Field(default_factory=list)
    related_tests: list[str] = Field(default_factory=list)
    unresolved_references: list[dict[str, Any]] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)


class DependencyOut(ORM):
    ecosystem: str
    name: str
    specifier: str | None
    scope: str
    manifest_path: str | None
    status: str
    evidence_id: str | None
    import_count: int


class FindingOut(ORM):
    id: int
    kind: str
    name: str
    detail: dict[str, Any]
    evidence_id: str | None
    confidence: str


class SearchHit(BaseModel):
    path: str
    snippet: str
    score: float


class ReportBrief(ORM):
    id: int
    snapshot_id: int
    kind: str
    status: str
    model: str | None
    created_at: datetime
    error: str | None


class ReportOut(ReportBrief):
    content: dict[str, Any]
    usage: dict[str, Any]


class AgentModelOut(BaseModel):
    id: str
    provider_id: str
    model_id: str
    name: str
    family: str | None
    status: str | None
    enabled: bool
    context_limit: int | None
    output_limit: int | None
    variants: list[str]


class AgentStatusOut(BaseModel):
    mode: str
    available: bool
    version: str | None
    base_url: str | None
    error: str | None
    selected_model: str
    selected_model_available: bool | None
    agent_ready: bool


class ModelSelectIn(BaseModel):
    model: str = Field(min_length=3, max_length=200)
