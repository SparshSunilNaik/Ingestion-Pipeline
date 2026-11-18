"""Versioned evidence contract.

An evidence record points at an exact line range of a file inside one immutable
snapshot (repository + commit SHA). IDs are stable: the same extraction over the
same commit yields the same ID.
"""

from __future__ import annotations

import hashlib
from enum import StrEnum

from pydantic import BaseModel, Field

CONTRACT_VERSION = "1.0"
ANALYZER_VERSION = "0.1.0"


class EvidenceCategory(StrEnum):
    SYMBOL_DEFINITION = "symbol_definition"
    IMPORT = "import"
    CALL = "call"
    ROUTE = "route"
    FRAMEWORK_USAGE = "framework_usage"
    DEPENDENCY_DECLARATION = "dependency_declaration"
    ENTRY_POINT = "entry_point"
    DOCUMENTATION = "documentation"
    CONFIGURATION = "configuration"
    TEST = "test"
    CI = "ci"
    CONTAINER = "container"
    RETRIEVED_SOURCE = "retrieved_source"


class ExtractionMethod(StrEnum):
    PYTHON_AST = "python_ast"
    TREE_SITTER = "tree_sitter"
    MANIFEST_PARSER = "manifest_parser"
    INVENTORY = "inventory"
    DOC_SECTION = "doc_section"
    GATEWAY_READ = "gateway_read"


class VerificationStatus(StrEnum):
    VERIFIED = "verified"  # path and line range checked against the snapshot on disk
    UNVERIFIED = "unverified"
    INVALID = "invalid"


class SourceKind(StrEnum):
    SOURCE = "source"
    TEST = "test"
    DOCUMENTATION = "documentation"
    CONFIGURATION = "configuration"
    MANIFEST = "manifest"


CATEGORY_TO_SOURCE_KIND = {
    "source": SourceKind.SOURCE,
    "test": SourceKind.TEST,
    "documentation": SourceKind.DOCUMENTATION,
    "dependency_manifest": SourceKind.MANIFEST,
    "configuration": SourceKind.CONFIGURATION,
    "ci": SourceKind.CONFIGURATION,
    "container": SourceKind.CONFIGURATION,
}


class EvidenceRecord(BaseModel):
    id: str
    repository_id: int
    commit_sha: str
    path: str
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    category: EvidenceCategory
    subject: str | None = None
    extraction_method: ExtractionMethod
    analyzer_version: str = ANALYZER_VERSION
    contract_version: str = CONTRACT_VERSION
    verification_status: VerificationStatus = VerificationStatus.UNVERIFIED
    source_kind: SourceKind
    limitations: list[str] = Field(default_factory=list)
    excerpt_sha256: str | None = None


def evidence_id(commit_sha: str, path: str, start: int, end: int, category: str, method: str, subject: str | None) -> str:
    key = "\x1f".join([CONTRACT_VERSION, commit_sha, path, str(start), str(end), category, method, subject or ""])
    return "ev_" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]
