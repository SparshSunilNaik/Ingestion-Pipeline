"""Ingestion pipeline: resolve -> (cache) -> clone -> inventory -> promote -> analyse -> report.

Guarantees:
  * a failed refresh never modifies or deletes the repository's last valid snapshot;
  * snapshot directories are promoted with an atomic rename from the staging area;
  * the same commit is never analysed twice by the same analyzer version (cache reuse).
"""

from __future__ import annotations

import contextlib
import os
import uuid
from collections.abc import Callable
from pathlib import Path

from sqlalchemy import insert, select
from sqlalchemy.orm import Session

from app.analysis.engine import SnapshotAnalyzer
from app.core.config import Settings
from app.core.errors import AcquisitionError, AppError, LimitExceeded
from app.core.logging import get_logger
from app.database.models import FileRecord, Job, Repository, Snapshot
from app.evidence.contract import ANALYZER_VERSION
from app.ingestion import jobs as jobstore
from app.ingestion.git_ops import GitRepositoryClient, GitRunner, rmtree_safe
from app.ingestion.inventory import build_inventory
from app.ingestion.url import GitHubRepoRef, parse_github_url
from app.reports.builder import build_deterministic_report

log = get_logger(__name__)


class JobCancelled(AppError):
    code = "cancelled"


def _dir_size(path: Path) -> int:
    total = 0
    for dirpath, dirnames, filenames in os.walk(path, followlinks=False):
        if ".git" in dirnames and Path(dirpath) == path:
            dirnames.remove(".git")
        for f in filenames:
            with contextlib.suppress(OSError):
                total += os.lstat(os.path.join(dirpath, f)).st_size
    return total


class IngestionPipeline:
    def __init__(self, settings: Settings, clone_url_resolver: Callable[[GitHubRepoRef], str] | None = None) -> None:
        self.settings = settings
        self.git = GitRepositoryClient(GitRunner(settings.git_sandbox_dir, settings.git_allowed_protocols, settings.git_executable))
        self.clone_url_for = clone_url_resolver or (lambda ref: ref.clone_url)

    def snapshot_dir(self, repo: Repository, sha: str) -> Path:
        return self.settings.snapshots_dir / repo.owner / repo.name / sha

    def _progress(self, session: Session, job_id: int, stage: str, pct: int, msg: str | None = None) -> None:
        if jobstore.cancel_requested(session, job_id):
            raise JobCancelled("Job cancelled by user")
        jobstore.update_progress(session, job_id, stage, pct, msg)

    def run(self, session: Session, job_id: int) -> int:
        """Execute an ingest job. Returns the snapshot id. Raises AppError on failure."""
        job = session.get(Job, job_id)
        assert job is not None
        limits = self.settings.limits
        ref = parse_github_url(job.requested_url)
        repo = session.get(Repository, job.repository_id)
        assert repo is not None
        clone_url = self.clone_url_for(ref)

        self._progress(session, job_id, "resolving", 5, f"Resolving HEAD of {ref.slug}")
        remote = self.git.remote_head(clone_url, timeout=min(60, limits.clone_timeout_seconds))
        if remote.default_branch:
            repo.default_branch = remote.default_branch

        cached = session.scalar(select(Snapshot).where(Snapshot.repository_id == repo.id, Snapshot.commit_sha == remote.commit_sha))
        if cached is not None and cached.status == "ready" and cached.analyzer_version == ANALYZER_VERSION:
            repo.current_snapshot_id = cached.id
            session.commit()
            jobstore.update_progress(session, job_id, "cached", 95, f"Reusing analysed snapshot {remote.commit_sha[:12]}")
            jobstore.finish_job(session, job_id, "succeeded", snapshot_id=cached.id, reused=True)
            return cached.id

        staging = self.settings.staging_dir / f"job-{job_id}-{uuid.uuid4().hex[:8]}"
        checkout = staging / "checkout"
        staging.mkdir(parents=True, exist_ok=False)
        promoted: Path | None = None
        snapshot: Snapshot | None = None
        created_snapshot = False
        try:
            self._progress(session, job_id, "cloning", 15, f"Shallow clone (depth {limits.max_commits})")
            self.git.shallow_clone(clone_url, checkout, depth=limits.max_commits, timeout=limits.clone_timeout_seconds)
            sha = self.git.head_sha(checkout)
            branch = self.git.current_branch(checkout) or remote.default_branch
            entries = self.git.tracked_entries(checkout)
            commits = self.git.recent_commits(checkout, limits.max_commits)
            size = _dir_size(checkout)
            if size > limits.max_repo_storage_bytes:
                raise LimitExceeded(f"Checkout is {size} bytes, above the storage budget of {limits.max_repo_storage_bytes} bytes")
            rmtree_safe(checkout / ".git")  # snapshots keep the working tree only

            self._progress(session, job_id, "inventory", 35, f"Classifying {len(entries)} tracked files")
            inventory = build_inventory(checkout, entries, limits)

            # Atomic promotion into the content-addressed snapshot location.
            final = self.snapshot_dir(repo, sha)
            existing = session.scalar(select(Snapshot).where(Snapshot.repository_id == repo.id, Snapshot.commit_sha == sha))
            final.parent.mkdir(parents=True, exist_ok=True)
            if final.exists():
                # Same commit = same content. Keep the existing directory if a snapshot row owns it.
                if existing is None:
                    rmtree_safe(final)
                    os.replace(checkout, final)
                    promoted = final
            else:
                os.replace(checkout, final)
                promoted = final

            if existing is None:
                snapshot = Snapshot(repository_id=repo.id, commit_sha=sha, storage_path=str(final), analyzer_version=ANALYZER_VERSION, status="analyzing")
                session.add(snapshot)
                session.flush()
                created_snapshot = True
            else:
                snapshot = existing
                snapshot.status = "analyzing"
                snapshot.analyzer_version = ANALYZER_VERSION
                snapshot.storage_path = str(final)
                session.query(FileRecord).filter(FileRecord.snapshot_id == snapshot.id).delete()
            snapshot.default_branch = branch
            snapshot.commit_info = commits[0] if commits else {"sha": sha}
            snapshot.recent_commits = commits
            snapshot.coverage = inventory.coverage
            snapshot.inventory_summary = inventory.summary
            session.execute(
                insert(FileRecord),
                [
                    {
                        "snapshot_id": snapshot.id,
                        "path": f.path,
                        "size": f.size,
                        "extension": f.extension[:32],
                        "language": f.language,
                        "category": f.category,
                        "is_text": f.is_text,
                        "analyzed": f.analyzed,
                        "exclusion_reason": f.exclusion_reason,
                        "line_count": f.line_count,
                        "sha256": f.sha256,
                    }
                    for f in inventory.files
                ],
            )
            session.commit()

            self._progress(session, job_id, "analyzing", 55, "Parsing source, resolving references, building graph")
            summary = SnapshotAnalyzer(session, repo, snapshot).run()
            snapshot.analysis_summary = summary
            session.commit()

            self._progress(session, job_id, "reporting", 85, "Generating evidence-grounded report")
            build_deterministic_report(session, snapshot)

            snapshot.status = "ready"
            repo.current_snapshot_id = snapshot.id  # only now does the repository point at the new snapshot
            repo.default_branch = branch
            session.commit()
            jobstore.finish_job(session, job_id, "succeeded", snapshot_id=snapshot.id, reused=False)
            return snapshot.id
        except Exception:
            session.rollback()
            if snapshot is not None and snapshot.id is not None:
                snap = session.get(Snapshot, snapshot.id)
                if snap is not None and snap.status != "ready":
                    if created_snapshot:
                        session.delete(snap)
                    else:
                        snap.status = "failed"
                    session.commit()
            if promoted is not None and created_snapshot:
                rmtree_safe(promoted)
            raise
        finally:
            rmtree_safe(staging)


def run_ingest(session: Session, pipeline: IngestionPipeline, job_id: int) -> None:
    try:
        pipeline.run(session, job_id)
    except JobCancelled:
        session.rollback()
        jobstore.finish_job(session, job_id, "cancelled", error_code="cancelled", error_message="Cancelled by user")
    except AppError as exc:
        session.rollback()
        log.warning("ingest job %s failed: %s", job_id, exc.message)
        jobstore.finish_job(session, job_id, "failed", error_code=exc.code, error_message=exc.message)
    except Exception as exc:  # unexpected
        session.rollback()
        log.exception("ingest job %s crashed", job_id)
        jobstore.finish_job(session, job_id, "failed", error_code="internal_error", error_message=f"{type(exc).__name__}: analysis failed")


__all__ = ["AcquisitionError", "IngestionPipeline", "run_ingest"]
