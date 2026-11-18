"""Build a file inventory of a checked-out snapshot with explicit exclusions and coverage."""

from __future__ import annotations

import hashlib
import os
import posixpath
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.core.config import RepositoryLimits
from app.ingestion.classify import classify, looks_binary, unsafe_path_reason
from app.ingestion.git_ops import TrackedEntry

ANALYZABLE_CATEGORIES = {"source", "test", "configuration", "dependency_manifest", "documentation", "ci", "container"}
# Lower number = analysed first when budgets are tight.
_PRIORITY = {"dependency_manifest": 0, "documentation": 1, "source": 2, "configuration": 3, "ci": 4, "container": 4, "test": 5}


@dataclass
class InventoryFile:
    path: str
    size: int
    extension: str
    language: str | None
    category: str
    is_text: bool = False
    analyzed: bool = False
    exclusion_reason: str | None = None
    line_count: int | None = None
    sha256: str | None = None


@dataclass
class Inventory:
    files: list[InventoryFile]
    coverage: dict[str, Any] = field(default_factory=dict)
    summary: dict[str, Any] = field(default_factory=dict)


def resolve_inside(root: Path, rel: str) -> Path | None:
    """Return the absolute path for ``rel`` only if it stays inside ``root`` and has no link components."""
    if unsafe_path_reason(rel):
        return None
    root_real = Path(os.path.realpath(root))
    candidate = root_real.joinpath(*rel.split("/"))
    # Reject any symlink/junction component between root and the file.
    cur = root_real
    for part in rel.split("/"):
        cur = cur / part
        if cur.is_symlink() or (hasattr(cur, "is_junction") and cur.is_junction()):
            return None
    real = Path(os.path.realpath(candidate))
    try:
        real.relative_to(root_real)
    except ValueError:
        return None
    return real


def build_inventory(root: Path, entries: list[TrackedEntry], limits: RepositoryLimits) -> Inventory:
    files: list[InventoryFile] = []
    for entry in entries[: limits.max_tracked_files]:
        path = entry.path
        ext = posixpath.splitext(path.lower())[1]
        reason = unsafe_path_reason(path)
        if reason:
            files.append(
                InventoryFile(path=_display_path(path), size=0, extension=ext, language=None, category="unsafe", exclusion_reason=f"unsafe_path:{reason}")
            )
            continue
        if entry.mode == "120000":
            files.append(InventoryFile(path=path, size=0, extension=ext, language=None, category="symlink", exclusion_reason="symlink"))
            continue
        if entry.mode == "160000":
            files.append(InventoryFile(path=path, size=0, extension=ext, language=None, category="submodule", exclusion_reason="submodule_not_fetched"))
            continue
        cls = classify(path)
        abs_path = resolve_inside(root, path)
        if abs_path is None or not abs_path.is_file():
            files.append(
                InventoryFile(path=path, size=0, extension=ext, language=cls.language, category=cls.category, exclusion_reason="missing_or_unsafe_on_disk")
            )
            continue
        size = abs_path.stat().st_size
        rec = InventoryFile(path=path, size=size, extension=ext, language=cls.language, category=cls.category, exclusion_reason=cls.exclusion_reason)
        if cls.category != "binary":
            with abs_path.open("rb") as fh:
                sample = fh.read(8192)
            rec.is_text = not looks_binary(sample)
            if not rec.is_text:
                rec.category = "binary"
                rec.exclusion_reason = rec.exclusion_reason or "binary"
        files.append(rec)

    if len(entries) > limits.max_tracked_files:
        coverage_truncated_tracked = len(entries) - limits.max_tracked_files
    else:
        coverage_truncated_tracked = 0

    # Select files to analyse within budgets.
    candidates = [f for f in files if f.exclusion_reason is None and f.is_text and f.category in ANALYZABLE_CATEGORIES]
    candidates.sort(key=lambda f: (_PRIORITY.get(f.category, 9), f.path.count("/"), f.path))
    total = 0
    count = 0
    for f in candidates:
        if f.size > limits.max_file_bytes:
            f.exclusion_reason = "file_too_large"
            continue
        if count >= limits.max_analyzed_files:
            f.exclusion_reason = "file_count_limit"
            continue
        if total + f.size > limits.max_total_source_bytes:
            f.exclusion_reason = "total_size_limit"
            continue
        abs_path = resolve_inside(root, f.path)
        assert abs_path is not None
        data = abs_path.read_bytes()
        f.sha256 = hashlib.sha256(data).hexdigest()
        f.line_count = _count_lines(data)
        f.analyzed = True
        total += f.size
        count += 1

    exclusions = Counter(f.exclusion_reason for f in files if f.exclusion_reason)
    languages = Counter(f.language for f in files if f.language and f.category in {"source", "test"})
    language_bytes: Counter[str] = Counter()
    for f in files:
        if f.language and f.category in {"source", "test"}:
            language_bytes[f.language] += f.size
    categories = Counter(f.category for f in files)
    eligible = sum(
        1
        for f in files
        if f.is_text and f.category in ANALYZABLE_CATEGORIES and f.exclusion_reason not in {"dependency_directory", "generated_artifact", "lockfile"}
    )
    budget_skips = sum(exclusions.get(k, 0) for k in ("file_too_large", "file_count_limit", "total_size_limit"))
    coverage = {
        "tracked_files": len(entries),
        "inventoried_files": len(files),
        "tracked_files_beyond_limit": coverage_truncated_tracked,
        "eligible_text_files": eligible,
        "analyzed_files": count,
        "analyzed_bytes": total,
        "budget_skipped_files": budget_skips,
        "is_partial": budget_skips > 0 or coverage_truncated_tracked > 0,
        "exclusions": dict(exclusions),
        "limits": limits.model_dump(),
    }
    top_dirs = Counter(f.path.split("/")[0] for f in files if "/" in f.path)
    summary = {
        "languages_by_files": dict(languages.most_common()),
        "languages_by_bytes": dict(language_bytes.most_common()),
        "categories": dict(categories),
        "top_level_directories": dict(top_dirs.most_common(30)),
        "documentation_files": [f.path for f in files if f.category == "documentation"][:100],
        "dependency_manifests": [f.path for f in files if f.category == "dependency_manifest"][:100],
        "configuration_files": [f.path for f in files if f.category == "configuration"][:100],
        "test_files_count": categories.get("test", 0),
        "ci_files": [f.path for f in files if f.category == "ci"][:50],
        "container_files": [f.path for f in files if f.category == "container"][:50],
        "source_directories": sorted({posixpath.dirname(f.path) or "." for f in files if f.category == "source"})[:200],
        "total_bytes": sum(f.size for f in files),
    }
    return Inventory(files=files, coverage=coverage, summary=summary)


def _count_lines(data: bytes) -> int:
    if not data:
        return 0
    return data.count(b"\n") + (0 if data.endswith(b"\n") else 1)


def _display_path(path: str) -> str:
    return "".join(c if 32 <= ord(c) < 127 or ord(c) > 159 else "?" for c in path)[:1000]
