from __future__ import annotations

import shutil
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest

from app.core.config import RepositoryLimits, Settings
from app.database.engine import init_engine, session_factory
from app.database.migrate import upgrade_database
from app.ingestion.pipeline import IngestionPipeline
from app.ingestion.url import GitHubRepoRef

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "tests" / "fixtures"
SAMPLE_REPO = FIXTURES / "sample_repo"


def git(cwd: Path, *args: str) -> str:
    env_args = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", "-c", "core.symlinks=false"]
    res = subprocess.run(["git", *env_args, *args], cwd=cwd, capture_output=True, text=True, check=True)
    return res.stdout


def make_git_repo(
    dest: Path, source: Path | None = None, extra: dict[str, bytes] | None = None, symlinks: dict[str, str] | None = None, commits: int = 1
) -> Path:
    dest.mkdir(parents=True, exist_ok=True)
    if source is not None:
        shutil.copytree(source, dest, dirs_exist_ok=True)
    for rel, data in (extra or {}).items():
        p = dest / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    git(dest, "init", "-q", "-b", "main")
    git(dest, "add", "-A")
    for link, target in (symlinks or {}).items():
        blob = subprocess.run(["git", "hash-object", "-w", "--stdin"], cwd=dest, input=target, capture_output=True, text=True, check=True).stdout.strip()
        git(dest, "update-index", "--add", "--cacheinfo", f"120000,{blob},{link}")
        git(dest, "-c", "core.symlinks=false", "checkout", "--", link)  # materialise so later `add -A` keeps it
    git(dest, "commit", "-q", "-m", "initial")
    for i in range(1, commits):
        (dest / f"CHANGELOG_{i}.md").write_text(f"# change {i}\n", encoding="utf-8")
        git(dest, "add", "-A")
        git(dest, "commit", "-q", "-m", f"change {i}")
    return dest


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    s = Settings(
        data_dir=tmp_path / "data",
        start_worker=False,
        git_allowed_protocols="file",
        limits=RepositoryLimits(clone_timeout_seconds=60),
    )
    s.opencode.mode = "disabled"
    s.ensure_dirs()
    return s


@pytest.fixture
def db(settings: Settings) -> Iterator[None]:
    url = settings.resolved_database_url
    upgrade_database(url)
    init_engine(url)
    yield


@pytest.fixture
def session(db: None):
    s = session_factory()()
    try:
        yield s
    finally:
        s.close()


class LocalRemotes:
    """Maps github.com/<owner>/<name> to local file:// repositories for offline tests."""

    def __init__(self) -> None:
        self.map: dict[str, Path] = {}

    def add(self, slug: str, path: Path) -> None:
        self.map[slug.lower()] = path

    def __call__(self, ref: GitHubRepoRef) -> str:
        path = self.map[ref.slug.lower()]
        return path.resolve().as_uri()


@pytest.fixture
def remotes() -> LocalRemotes:
    return LocalRemotes()


@pytest.fixture
def pipeline(settings: Settings, remotes: LocalRemotes) -> IngestionPipeline:
    return IngestionPipeline(settings, clone_url_resolver=remotes)


@pytest.fixture
def sample_remote(tmp_path: Path, remotes: LocalRemotes) -> Path:
    path = make_git_repo(tmp_path / "remotes" / "sample", SAMPLE_REPO, symlinks={"docs/link-to-secret": "../../../../etc/passwd"}, commits=3)
    remotes.add("acme/sample", path)
    return path
