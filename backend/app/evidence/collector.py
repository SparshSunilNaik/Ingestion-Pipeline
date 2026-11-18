"""Collects evidence records during analysis, verifying each against file content as it is created."""

from __future__ import annotations

from app.evidence.contract import (
    ANALYZER_VERSION,
    CONTRACT_VERSION,
    EvidenceCategory,
    ExtractionMethod,
    SourceKind,
    VerificationStatus,
    evidence_id,
)
from app.evidence.verifier import excerpt_hash


class EvidenceCollector:
    def __init__(
        self,
        snapshot_id: int,
        repository_id: int,
        commit_sha: str,
        file_lines: dict[str, list[str]],
        source_kinds: dict[str, SourceKind],
        analyzer_version: str = ANALYZER_VERSION,
    ) -> None:
        self.analyzer_version = analyzer_version
        self.snapshot_id = snapshot_id
        self.repository_id = repository_id
        self.commit_sha = commit_sha
        self.file_lines = file_lines
        self.source_kinds = source_kinds
        self.records: dict[str, dict] = {}
        self.rejected = 0

    def add(
        self,
        path: str,
        start: int,
        end: int,
        category: EvidenceCategory,
        method: ExtractionMethod,
        subject: str | None = None,
        limitations: list[str] | None = None,
    ) -> str | None:
        lines = self.file_lines.get(path)
        if lines is None:
            self.rejected += 1
            return None
        n = max(len(lines), 1)
        start = max(1, start)
        end = min(max(start, end), n)
        if start > n:
            self.rejected += 1
            return None
        eid = evidence_id(self.commit_sha, path, start, end, category.value, method.value, subject, self.analyzer_version)
        if eid not in self.records:
            text = "\n".join(lines[start - 1 : end])
            self.records[eid] = {
                "id": eid,
                "snapshot_id": self.snapshot_id,
                "repository_id": self.repository_id,
                "commit_sha": self.commit_sha,
                "path": path,
                "start_line": start,
                "end_line": end,
                "category": category.value,
                "subject": (subject or "")[:600] or None,
                "extraction_method": method.value,
                "analyzer_version": self.analyzer_version,
                "contract_version": CONTRACT_VERSION,
                "verification_status": VerificationStatus.VERIFIED.value,
                "source_kind": self.source_kinds.get(path, SourceKind.SOURCE).value,
                "limitations": limitations or [],
                "excerpt_sha256": excerpt_hash(text),
            }
        return eid
