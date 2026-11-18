"""Report contract (versioned). Every statement carries its basis and evidence IDs."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

REPORT_SCHEMA_VERSION = "1.0"

Basis = Literal[
    "source_evidence",  # cites implementation source/test evidence
    "configuration_evidence",  # cites manifests / configuration only
    "documentation_claim",  # cites documentation only; not verified against code
    "inventory_measured",  # deterministic measurement of the file inventory
    "heuristic",  # deterministic heuristic judgement, not a proven fact
    "unknown",  # could not be determined
    "unsupported",  # agent statement without valid evidence (downgraded)
]


class Claim(BaseModel):
    statement: str = Field(max_length=4000)
    basis: Basis
    evidence_ids: list[str] = Field(default_factory=list)
    note: str | None = None


class Section(BaseModel):
    title: str
    claims: list[Claim] = Field(default_factory=list)


class EvidenceRef(BaseModel):
    id: str
    path: str
    start_line: int
    end_line: int
    category: str
    source_kind: str
    verification_status: str
    reason: str | None = None


class Report(BaseModel):
    schema_version: str = REPORT_SCHEMA_VERSION
    kind: Literal["deterministic", "agent"]
    repository: str
    canonical_url: str
    commit_sha: str
    default_branch: str | None
    generated_at: str
    model: str | None = None
    overview: list[Section]
    installation: list[Section]
    architecture: list[Section]
    code_structure: list[Section]
    engineering: list[Section]
    agent_narrative: list[Section] = Field(default_factory=list)
    coverage: dict
    evidence: list[EvidenceRef]
    evidence_summary: dict
