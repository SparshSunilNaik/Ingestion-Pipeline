"""Development/test utilities. Refuses to run unless IP_ENVIRONMENT=test.

    IP_ENVIRONMENT=test IP_DATA_DIR=... uv run python -m app.devtools seed-e2e

Creates local git repositories from tests/fixtures and ingests them through the real pipeline
(file:// remotes mapped to github.com/acme/* names), including a second commit of the bench
repository so snapshot comparison has data. Never used in production paths.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

from app.core.config import BACKEND_ROOT, get_settings
from app.database.engine import init_engine, session_factory
from app.database.migrate import upgrade_database
from app.database.models import Job
from app.ingestion import jobs as jobstore
from app.ingestion.pipeline import IngestionPipeline, run_ingest

FIXTURES = BACKEND_ROOT.parent / "tests" / "fixtures"


def _git(cwd: Path, *args: str) -> None:
    base = ["git", "-c", "user.name=Seed", "-c", "user.email=seed@example.invalid", "-c", "core.autocrlf=false"]
    base += ["-c", "commit.gpgsign=false", "-c", "core.symlinks=false"]
    subprocess.run([*base, *args], cwd=cwd, check=True, capture_output=True)


def _repo(src: Path, dest: Path) -> Path:
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src, dest)
    _git(dest, "init", "-q", "-b", "main")
    _git(dest, "add", "-A")
    _git(dest, "commit", "-q", "-m", "initial")
    return dest


def seed_e2e() -> None:
    settings = get_settings()
    if settings.environment != "test":
        sys.exit("refusing to seed: IP_ENVIRONMENT must be 'test'")
    settings.git_allowed_protocols = "file"
    settings.ensure_dirs()
    upgrade_database(settings.resolved_database_url)
    init_engine(settings.resolved_database_url)
    remotes_dir = settings.data_dir / "e2e-remotes"
    remotes = {"acme/sample": _repo(FIXTURES / "sample_repo", remotes_dir / "sample"), "acme/bench": _repo(FIXTURES / "bench_repo", remotes_dir / "bench")}
    pipeline = IngestionPipeline(settings, clone_url_resolver=lambda ref: remotes[ref.slug.lower()].resolve().as_uri())
    session = session_factory()()

    def ingest(slug: str) -> None:
        jobstore.create_ingest_job(session, f"https://github.com/{slug}")
        session.commit()
        jid = jobstore.claim_next_job(session, "seed", 600)
        assert jid is not None
        run_ingest(session, pipeline, jid)
        job = session.get(Job, jid, populate_existing=True)
        print(f"{slug}: {job.status if job else '?'} snapshot={job.snapshot_id if job else None}")

    ingest("acme/sample")
    ingest("acme/bench")
    bench = remotes["acme/bench"]
    tokens_v2 = "def issue_token(account) -> str:\n    return sign(account.name) + '.v2'\n\n\ndef sign(value: str) -> str:\n    return value[::-1]\n"
    (bench / "svc" / "core" / "tokens.py").write_text(tokens_v2, encoding="utf-8")
    (bench / "svc" / "core" / "audit.py").write_text("from .tokens import sign\n\n\ndef audit(event: str) -> str:\n    return sign(event)\n", encoding="utf-8")
    _git(bench, "add", "-A")
    _git(bench, "commit", "-q", "-m", "audit trail")
    ingest("acme/bench")
    session.close()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "seed-e2e":
        seed_e2e()
    else:
        sys.exit("usage: python -m app.devtools seed-e2e")
