from pathlib import Path

from sqlalchemy import func, select

from app.database.models import Evidence, FileRecord, GraphEdge, Job, Report, Repository, Snapshot
from app.evidence.verifier import SnapshotReader, verify_evidence
from app.ingestion import jobs
from app.ingestion.pipeline import IngestionPipeline
from app.ingestion.worker import Worker
from tests.conftest import git
from tests.integration.helpers import ingest


def test_ingest_sample_repository(session, pipeline, sample_remote, settings) -> None:
    job = ingest(session, pipeline)
    assert job.status == "succeeded", job.error_message
    snap = session.get(Snapshot, job.snapshot_id)
    expected_sha = git(sample_remote, "rev-parse", "HEAD").strip()
    assert snap.commit_sha == expected_sha
    assert snap.status == "ready"
    assert snap.default_branch == "main"
    assert len(snap.recent_commits) == 3
    repo = session.get(Repository, snap.repository_id)
    assert repo.current_snapshot_id == snap.id

    tracked = set(git(sample_remote, "ls-files").split())
    files = {f.path: f for f in session.scalars(select(FileRecord).where(FileRecord.snapshot_id == snap.id))}
    assert set(files) == tracked
    assert snap.coverage["tracked_files"] == len(tracked)
    assert files["docs/link-to-secret"].category == "symlink" and not files["docs/link-to-secret"].analyzed
    assert files["docs/logo.png"].exclusion_reason == "binary"
    assert files["app/main.py"].language == "python" and files["app/main.py"].analyzed
    assert files["web/app/page.tsx"].language == "typescript"
    assert files["tests/test_inventory.py"].category == "test"
    assert set(snap.inventory_summary["languages_by_files"]) == {"python", "typescript"}

    # snapshot directory: working tree only, no .git, staging cleaned up
    root = Path(snap.storage_path)
    assert (root / "app" / "main.py").is_file()
    assert not (root / ".git").exists()
    assert list(settings.staging_dir.iterdir()) == []

    # every persisted evidence record re-verifies against the snapshot on disk
    reader = SnapshotReader(session, snap)
    evs = session.scalars(select(Evidence).where(Evidence.snapshot_id == snap.id)).all()
    assert len(evs) > 50
    assert all(verify_evidence(reader, e).ok for e in evs)
    assert {e.commit_sha for e in evs} == {expected_sha}

    # graph: resolved cross-file call and inheritance edges exist; no edges to unknown nodes
    edges = {(e.source_key, e.target_key, e.kind, e.resolution) for e in session.scalars(select(GraphEdge).where(GraphEdge.snapshot_id == snap.id))}
    assert ("sym:app/api/routes.py#create_item", "sym:app/services/inventory.py#make_item", "calls", "resolved") in edges
    assert ("sym:app/services/inventory.py#InventoryService", "sym:app/services/inventory.py#BaseService", "inherits", "resolved") in edges
    assert ("file:web/app/page.tsx", "file:web/src/lib/api.ts", "imports", "resolved") in edges  # via tsconfig alias
    assert ("file:app/main.py", "pkg:python:yaml", "imports", "external") in edges

    report = session.scalar(select(Report).where(Report.snapshot_id == snap.id, Report.kind == "deterministic"))
    assert report is not None and report.content["commit_sha"] == expected_sha
    assert report.content["evidence_summary"].get("invalid", 0) == 0
    assert "# Repository report: acme/sample" in report.markdown


def test_duplicate_ingestion_reuses_cache(session, pipeline, sample_remote) -> None:
    first = ingest(session, pipeline)
    second = ingest(session, pipeline)
    assert second.status == "succeeded" and second.reused_cache
    assert second.snapshot_id == first.snapshot_id
    assert session.scalar(select(func.count()).select_from(Snapshot)) == 1


def test_new_commit_creates_new_snapshot_and_keeps_old(session, pipeline, sample_remote) -> None:
    first = ingest(session, pipeline)
    (sample_remote / "app" / "extra.py").write_text("def extra():\n    return 1\n", encoding="utf-8")
    git(sample_remote, "add", "-A")
    git(sample_remote, "commit", "-q", "-m", "extra")
    second = ingest(session, pipeline)
    assert second.status == "succeeded" and not second.reused_cache
    assert second.snapshot_id != first.snapshot_id
    old = session.get(Snapshot, first.snapshot_id)
    assert old.status == "ready" and Path(old.storage_path).is_dir()
    assert session.get(Repository, old.repository_id).current_snapshot_id == second.snapshot_id


def test_failed_refresh_preserves_last_valid_snapshot(session, pipeline, sample_remote, remotes, tmp_path) -> None:
    first = ingest(session, pipeline)
    snap = session.get(Snapshot, first.snapshot_id)
    remotes.add("acme/sample", tmp_path / "does-not-exist")
    failed = ingest(session, pipeline)
    assert failed.status == "failed" and failed.error_code == "acquisition_failed"
    repo = session.get(Repository, snap.repository_id)
    assert repo.current_snapshot_id == snap.id
    assert Path(snap.storage_path).joinpath("app", "main.py").is_file()


def test_failure_during_analysis_cleans_up(session, settings, remotes, sample_remote, monkeypatch) -> None:
    from app.ingestion import pipeline as pl

    def boom(*a, **k):
        raise RuntimeError("analysis exploded")

    monkeypatch.setattr(pl.SnapshotAnalyzer, "run", boom)
    p = IngestionPipeline(settings, clone_url_resolver=remotes)
    job = ingest(session, p)
    assert job.status == "failed" and job.error_code == "internal_error"
    assert session.scalar(select(func.count()).select_from(Snapshot)) == 0
    assert not any(settings.snapshots_dir.rglob("main.py"))
    assert list(settings.staging_dir.iterdir()) == []


def test_partial_coverage_with_small_limits(session, settings, remotes, sample_remote) -> None:
    settings.limits.max_analyzed_files = 5
    settings.limits.max_file_bytes = 600
    job = ingest(session, IngestionPipeline(settings, clone_url_resolver=remotes))
    snap = session.get(Snapshot, job.snapshot_id)
    assert snap.coverage["is_partial"] is True
    assert snap.coverage["analyzed_files"] == 5
    assert snap.coverage["exclusions"].get("file_too_large", 0) >= 1
    assert snap.coverage["exclusions"].get("file_count_limit", 0) >= 1
    report = session.scalar(select(Report).where(Report.snapshot_id == snap.id))
    assert "PARTIAL" in report.markdown


def test_storage_budget_enforced(session, settings, remotes, sample_remote) -> None:
    settings.limits.max_repo_storage_bytes = 100
    job = ingest(session, IngestionPipeline(settings, clone_url_resolver=remotes))
    assert job.status == "failed" and job.error_code == "limit_exceeded"


def test_worker_recovers_interrupted_job(session, settings, remotes, sample_remote) -> None:
    from datetime import timedelta

    job, _ = jobs.create_ingest_job(session, "https://github.com/acme/sample")
    session.commit()
    jobs.claim_next_job(session, "crashed-worker", 60)
    j = session.get(Job, job.id, populate_existing=True)
    j.lease_expires_at = jobs.now() - timedelta(seconds=1)
    session.commit()
    w = Worker(settings, runtime=None, pipeline=IngestionPipeline(settings, clone_url_resolver=remotes))  # type: ignore[arg-type]
    assert w.run_once() == job.id
    j = session.get(Job, job.id, populate_existing=True)
    assert j.status == "succeeded" and j.attempts == 2
    assert w.run_once() is None
