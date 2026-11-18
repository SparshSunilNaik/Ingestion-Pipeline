import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import select

from app.agents.gateway import GatewayBudget, ReadFileRange, ReadOnlyGateway, SearchCode
from app.core.config import RepositoryLimits
from app.core.errors import AcquisitionError
from app.core.logging import redact
from app.database.models import FileRecord
from app.evidence.verifier import SnapshotReader, verify_location
from app.ingestion.git_ops import GitRepositoryClient, GitRunner, TrackedEntry
from app.ingestion.inventory import build_inventory, resolve_inside
from tests.conftest import SAMPLE_REPO, git, make_git_repo
from tests.integration.helpers import ready_snapshot


def test_git_environment_is_hardened(tmp_path) -> None:
    r = GitRunner(tmp_path / "sb", allowed_protocols="https")
    env = r.env()
    assert env["GIT_TERMINAL_PROMPT"] == "0"
    assert env["GIT_LFS_SKIP_SMUDGE"] == "1"
    assert env["GIT_CONFIG_NOSYSTEM"] == "1"
    assert env["GIT_ALLOW_PROTOCOL"] == "https"
    assert Path(env["GIT_CONFIG_GLOBAL"]).read_text() == ""
    args = " ".join(r.base_args())
    for needle in [
        "core.hooksPath=",
        "core.symlinks=false",
        "credential.helper=",
        "submodule.recurse=false",
        "protocol.allow=never",
        "protocol.ext.allow=never",
        "filter.lfs.smudge=",
        "transfer.fsckObjects=true",
    ]:
        assert needle in args


def test_inherited_git_config_and_hooks_are_ignored(tmp_path, monkeypatch) -> None:
    """A malicious global config (hooksPath + hook) must not run during our clone."""
    remote = make_git_repo(tmp_path / "remote", extra={"a.txt": b"hi\n"})
    hooks = tmp_path / "evil-hooks"
    hooks.mkdir()
    marker = tmp_path / "PWNED"
    hook = hooks / "post-checkout"
    hook.write_text(f"#!/bin/sh\necho pwned > '{marker.as_posix()}'\n", encoding="utf-8")
    hook.chmod(0o755)
    evil_cfg = tmp_path / "evil.gitconfig"
    evil_cfg.write_text(f"[core]\n\thooksPath = {hooks.as_posix()}\n", encoding="utf-8")

    # Control: plain git with this config DOES run the hook (proves the test is meaningful).
    env = {**os.environ, "GIT_CONFIG_GLOBAL": str(evil_cfg)}
    subprocess.run(["git", "clone", "-q", str(remote), str(tmp_path / "control")], env=env, check=True, capture_output=True)
    if not marker.exists():
        pytest.skip("this platform's git cannot execute shell hooks; control did not fire")
    marker.unlink()

    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(evil_cfg))
    client = GitRepositoryClient(GitRunner(tmp_path / "sb", allowed_protocols="file"))
    client.shallow_clone(remote.resolve().as_uri(), tmp_path / "ours", depth=1, timeout=60)
    assert (tmp_path / "ours" / "a.txt").exists()
    assert not marker.exists()


def test_protocol_allowlist(tmp_path) -> None:
    remote = make_git_repo(tmp_path / "remote", extra={"a.txt": b"x"})
    https_only = GitRepositoryClient(GitRunner(tmp_path / "sb1", allowed_protocols="https"))
    with pytest.raises(AcquisitionError):
        https_only.shallow_clone(remote.resolve().as_uri(), tmp_path / "c1", depth=1, timeout=60)
    with pytest.raises(AcquisitionError):
        https_only.remote_head("ext::sh -c touch% /tmp/pwned", timeout=30)


def test_clone_timeout_kills_process(tmp_path, monkeypatch) -> None:
    r = GitRunner(tmp_path / "sb")
    # `git credential fill` waits on stdin forever -> but stdin is DEVNULL; use a sleeping alias instead.
    with pytest.raises(AcquisitionError, match="timed out"):
        r.run(["-c", "alias.slow=!sleep 30", "slow"] if sys.platform != "win32" else ["-c", "alias.slow=!ping -n 30 127.0.0.1", "slow"], cwd=None, timeout=1)


def test_symlinks_are_checked_out_as_plain_files_and_excluded(session, pipeline, sample_remote) -> None:
    snap = ready_snapshot(session, pipeline)
    rec = session.scalar(select(FileRecord).where(FileRecord.snapshot_id == snap.id, FileRecord.path == "docs/link-to-secret"))
    assert rec.category == "symlink" and rec.exclusion_reason == "symlink"
    on_disk = Path(snap.storage_path) / "docs" / "link-to-secret"
    assert not on_disk.is_symlink()
    reader = SnapshotReader(session, snap)
    assert reader.lines("docs/link-to-secret") is None
    assert not verify_location(reader, "docs/link-to-secret", 1, 1).ok


def test_resolve_inside_rejects_escapes(tmp_path) -> None:
    root = tmp_path / "root"
    (root / "a").mkdir(parents=True)
    (root / "a" / "f.txt").write_text("x")
    (tmp_path / "secret.txt").write_text("s")
    assert resolve_inside(root, "a/f.txt") is not None
    for bad in ["../secret.txt", "a/../../secret.txt", "/etc/passwd", "C:/Windows/win.ini", "a\\..\\..\\secret.txt"]:
        assert resolve_inside(root, bad) is None
    try:
        os.symlink(tmp_path / "secret.txt", root / "a" / "link.txt")
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation not permitted on this machine")
    assert resolve_inside(root, "a/link.txt") is None


def test_malicious_tracked_paths_are_quarantined(tmp_path) -> None:
    root = tmp_path / "co"
    root.mkdir()
    (root / "ok.py").write_text("x = 1\n")
    entries = [
        TrackedEntry("ok.py", "100644"),
        TrackedEntry("../escape.py", "100644"),
        TrackedEntry("a/CON", "100644"),
        TrackedEntry("x:ads", "100644"),
        TrackedEntry("sub", "160000"),
        TrackedEntry("bad\x07.py", "100644"),
    ]
    inv = build_inventory(root, entries, RepositoryLimits())
    by = {f.path: f for f in inv.files}
    assert by["ok.py"].analyzed
    assert by["../escape.py"].exclusion_reason == "unsafe_path:path_traversal"
    assert by["a/CON"].exclusion_reason == "unsafe_path:windows_reserved_name"
    assert by["x:ads"].exclusion_reason.startswith("unsafe_path:")
    assert by["sub"].exclusion_reason == "submodule_not_fetched"
    assert any(f.exclusion_reason == "unsafe_path:control_characters" for f in inv.files)


def test_evidence_verifier_rejects_fabrications(session, pipeline, sample_remote) -> None:
    snap = ready_snapshot(session, pipeline)
    reader = SnapshotReader(session, snap)
    assert verify_location(reader, "app/main.py", 1, 5).ok
    assert verify_location(reader, "app/nonexistent.py", 1, 1).reason == "path_not_in_snapshot"
    assert verify_location(reader, "app/main.py", 0, 1).reason == "invalid_line_range"
    assert verify_location(reader, "app/main.py", 5, 2).reason == "invalid_line_range"
    assert verify_location(reader, "app/main.py", 1, 10_000).reason == "invalid_line_range"
    assert verify_location(reader, "../app/main.py", 1, 1).reason == "unsafe_path"
    assert verify_location(reader, "docs/logo.png", 1, 1).reason == "path_not_analyzed"


def test_gateway_budget_and_scope(session, pipeline, sample_remote) -> None:
    snap = ready_snapshot(session, pipeline)
    gw = ReadOnlyGateway(session, snap, GatewayBudget(max_requests=2, max_bytes=10_000))
    assert "error" not in gw.execute(ReadFileRange(tool="read_file_range", path="app/main.py", start_line=1, end_line=3))
    assert "error" in gw.execute(ReadFileRange(tool="read_file_range", path="C:/Windows/win.ini", start_line=1, end_line=3))
    assert gw.execute(SearchCode(tool="search", query="items"))["error"] == "request budget exhausted"
    with pytest.raises(ValueError):
        ReadFileRange.model_validate({"tool": "write_file", "path": "x"})


def test_log_redaction() -> None:
    assert "hunter2" not in redact("password=hunter2 token: abc123")
    assert "Zm9vOmJhcg==" not in redact("Authorization: Basic Zm9vOmJhcg==")
    assert "secret" not in redact("cloning https://user:secret@github.com/a/b")


def test_repository_scripts_are_never_executed(tmp_path, session, settings, remotes) -> None:
    """setup.py / package.json scripts / conftest in the analysed repo must not run."""
    marker = tmp_path / "EXECUTED"
    payload = f"open(r'{marker}', 'w').write('x')\n".encode()
    remote = make_git_repo(
        tmp_path / "evil",
        SAMPLE_REPO,
        extra={
            "setup.py": payload,
            "conftest.py": payload,
            "app/__init__.py": payload,
            "package.json": b'{"scripts": {"postinstall": "node -e \\"require(\'fs\').writeFileSync(\'EXECUTED\',\'x\')\\""}}',
        },
    )
    remotes.add("acme/evil", remote)
    from app.ingestion.pipeline import IngestionPipeline
    from tests.integration.helpers import ingest

    job = ingest(session, IngestionPipeline(settings, clone_url_resolver=remotes), "https://github.com/acme/evil")
    assert job.status == "succeeded"
    assert not marker.exists()
    assert git(remote, "rev-parse", "HEAD")
