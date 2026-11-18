"""Evidence verification against the exact snapshot on disk."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database.models import Evidence, FileRecord, Snapshot
from app.ingestion.classify import unsafe_path_reason
from app.ingestion.inventory import resolve_inside


@dataclass
class VerificationResult:
    ok: bool
    reason: str | None = None


class SnapshotReader:
    """Read-only access to the analysed files of one snapshot. Caches line splits."""

    def __init__(self, session: Session, snapshot: Snapshot) -> None:
        self.session = session
        self.snapshot = snapshot
        self.root = Path(snapshot.storage_path)
        self._files: dict[str, FileRecord] | None = None
        self._lines: dict[str, list[str]] = {}

    @property
    def files(self) -> dict[str, FileRecord]:
        if self._files is None:
            rows = self.session.scalars(select(FileRecord).where(FileRecord.snapshot_id == self.snapshot.id))
            self._files = {r.path: r for r in rows}
        return self._files

    def readable(self, path: str) -> FileRecord | None:
        rec = self.files.get(path)
        if rec is None or not rec.analyzed:
            return None
        return rec

    def lines(self, path: str) -> list[str] | None:
        if path in self._lines:
            return self._lines[path]
        if unsafe_path_reason(path) or self.readable(path) is None:
            return None
        abs_path = resolve_inside(self.root, path)
        if abs_path is None or not abs_path.is_file():
            return None
        text = abs_path.read_bytes().decode("utf-8", errors="replace")
        lines = text.splitlines()
        self._lines[path] = lines
        return lines

    def excerpt(self, path: str, start: int, end: int) -> str | None:
        lines = self.lines(path)
        if lines is None or start < 1 or end < start or end > max(len(lines), 1):
            return None
        return "\n".join(lines[start - 1 : end])


def excerpt_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def verify_location(reader: SnapshotReader, path: str, start: int, end: int) -> VerificationResult:
    if unsafe_path_reason(path):
        return VerificationResult(False, "unsafe_path")
    if path not in reader.files:
        return VerificationResult(False, "path_not_in_snapshot")
    if reader.readable(path) is None:
        return VerificationResult(False, "path_not_analyzed")
    lines = reader.lines(path)
    if lines is None:
        return VerificationResult(False, "unreadable")
    n = max(len(lines), 1)
    if start < 1 or end < start or end > n:
        return VerificationResult(False, "invalid_line_range")
    return VerificationResult(True)


def verify_evidence(reader: SnapshotReader, ev: Evidence) -> VerificationResult:
    if ev.snapshot_id != reader.snapshot.id or ev.commit_sha != reader.snapshot.commit_sha:
        return VerificationResult(False, "snapshot_mismatch")
    loc = verify_location(reader, ev.path, ev.start_line, ev.end_line)
    if not loc.ok:
        return loc
    if ev.excerpt_sha256:
        text = reader.excerpt(ev.path, ev.start_line, ev.end_line)
        if text is None or excerpt_hash(text) != ev.excerpt_sha256:
            return VerificationResult(False, "excerpt_mismatch")
    return VerificationResult(True)
