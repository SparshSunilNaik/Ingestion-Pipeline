"""Hardened Git subprocess integration.

Every Git invocation runs with:
  * no system/global config (isolated empty config files),
  * hooks disabled (``core.hooksPath`` points at an empty directory, empty template dir),
  * credential prompts disabled (``GIT_TERMINAL_PROMPT=0``, no askpass, no credential helper),
  * LFS smudge disabled, no submodule recursion, symlinks checked out as plain files,
  * a protocol allow-list (``https`` in production),
  * a hard timeout that kills the whole process tree.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from app.core.errors import AcquisitionError
from app.core.isolation import Limits, popen_limited
from app.core.logging import get_logger, redact

log = get_logger(__name__)

_HARDENING_CONFIG = [
    "core.symlinks=false",
    "core.protectNTFS=true",
    "core.protectHFS=true",
    "core.longpaths=true",
    "core.fsmonitor=false",
    "core.autocrlf=false",
    "credential.helper=",
    "filter.lfs.smudge=",
    "filter.lfs.process=",
    "filter.lfs.required=false",
    "submodule.recurse=false",
    "fetch.recurseSubmodules=false",
    "transfer.fsckObjects=true",
    "fetch.fsckObjects=true",
    "protocol.ext.allow=never",
    "protocol.fd.allow=never",
    "uploadpack.allowFilter=false",
    "safe.bareRepository=explicit",
    "advice.detachedHead=false",
    "init.defaultBranch=main",
]


@dataclass
class GitResult:
    stdout: str
    stderr: str
    returncode: int


class GitRunner:
    def __init__(self, sandbox_dir: Path, allowed_protocols: str = "https", executable: str = "git", limits: Limits | None = None) -> None:
        self.sandbox_dir = sandbox_dir
        self.limits = limits or Limits(memory_bytes=2048 * 1024 * 1024, max_processes=32, kill_on_close=True)
        self.allowed_protocols = allowed_protocols
        self.executable = executable
        sandbox_dir.mkdir(parents=True, exist_ok=True)
        self.hooks_dir = sandbox_dir / "empty-hooks"
        self.template_dir = sandbox_dir / "empty-template"
        self.home_dir = sandbox_dir / "home"
        for d in (self.hooks_dir, self.template_dir, self.home_dir):
            d.mkdir(parents=True, exist_ok=True)
        self.empty_config = sandbox_dir / "empty.gitconfig"
        if not self.empty_config.exists():
            self.empty_config.write_text("", encoding="utf-8")

    def env(self) -> dict[str, str]:
        keep = {"SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"}
        env = {k: v for k, v in os.environ.items() if k.upper() in keep}
        env.update(
            {
                "GIT_TERMINAL_PROMPT": "0",
                "GIT_ASKPASS": "",
                "SSH_ASKPASS": "",
                "GCM_INTERACTIVE": "never",
                "GIT_LFS_SKIP_SMUDGE": "1",
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": str(self.empty_config),
                "GIT_ALLOW_PROTOCOL": self.allowed_protocols.replace(",", ":"),
                "GIT_PROTOCOL_FROM_USER": "0",
                "GIT_TEMPLATE_DIR": str(self.template_dir),
                "HOME": str(self.home_dir),
                "USERPROFILE": str(self.home_dir),
                "XDG_CONFIG_HOME": str(self.home_dir),
                "GIT_NO_REPLACE_OBJECTS": "1",
            }
        )
        return env

    def base_args(self) -> list[str]:
        args = [self.executable]
        for item in [*_HARDENING_CONFIG, f"core.hooksPath={self.hooks_dir.as_posix()}"]:
            args += ["-c", item]
        for proto in self.allowed_protocols.split(","):
            args += ["-c", f"protocol.{proto.strip()}.allow=always"]
        args += ["-c", "protocol.allow=never"]
        return args

    def run(self, args: list[str], *, cwd: Path | None, timeout: float) -> GitResult:
        cmd = self.base_args() + args
        extra: dict = {}
        if sys.platform == "win32":
            extra["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc, job = popen_limited(
            cmd,
            self.limits,
            cwd=str(cwd) if cwd else str(self.sandbox_dir),
            env=self.env(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            **extra,
        )
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            if job is not None:
                job.close()  # kill-on-close terminates git and every helper it spawned
            else:
                _kill_tree(proc)
            proc.communicate()
            raise AcquisitionError(f"git {args[0]} timed out after {timeout:.0f}s") from exc
        finally:
            if job is not None:
                job.close()
        return GitResult(
            stdout=out.decode("utf-8", errors="replace"),
            stderr=redact(err.decode("utf-8", errors="replace")),
            returncode=proc.returncode,
        )

    def check(self, args: list[str], *, cwd: Path | None, timeout: float) -> str:
        res = self.run(args, cwd=cwd, timeout=timeout)
        if res.returncode != 0:
            msg = res.stderr.strip().splitlines()[-1:] or ["unknown error"]
            raise AcquisitionError(f"git {args[0]} failed: {msg[0][:300]}")
        return res.stdout


def _kill_tree(proc: subprocess.Popen[bytes]) -> None:
    try:
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except Exception:  # pragma: no cover - best effort
        proc.kill()


@dataclass
class RemoteHead:
    commit_sha: str
    default_branch: str | None


@dataclass
class TrackedEntry:
    path: str
    mode: str


class GitRepositoryClient:
    def __init__(self, runner: GitRunner) -> None:
        self.runner = runner

    def remote_head(self, clone_url: str, timeout: float) -> RemoteHead:
        out = self.runner.check(["ls-remote", "--symref", "--", clone_url, "HEAD"], cwd=None, timeout=timeout)
        sha: str | None = None
        branch: str | None = None
        for line in out.splitlines():
            if line.startswith("ref: ") and line.endswith("\tHEAD"):
                ref = line[5:].split("\t")[0]
                branch = ref.removeprefix("refs/heads/")
            elif line.endswith("\tHEAD"):
                sha = line.split("\t")[0].strip()
        if not sha or not _is_sha(sha):
            raise AcquisitionError("Could not resolve remote HEAD (repository missing, private or empty?)")
        return RemoteHead(commit_sha=sha, default_branch=branch)

    def shallow_clone(self, clone_url: str, dest: Path, depth: int, timeout: float) -> None:
        self.runner.check(
            [
                "clone",
                "--depth",
                str(max(1, depth)),
                "--single-branch",
                "--no-tags",
                "--no-recurse-submodules",
                f"--template={self.runner.template_dir.as_posix()}",
                "--",
                clone_url,
                str(dest),
            ],
            cwd=None,
            timeout=timeout,
        )

    def head_sha(self, repo: Path, timeout: float = 30) -> str:
        sha = self.runner.check(["rev-parse", "HEAD"], cwd=repo, timeout=timeout).strip()
        if not _is_sha(sha):
            raise AcquisitionError("Unexpected HEAD format")
        return sha

    def current_branch(self, repo: Path, timeout: float = 30) -> str | None:
        res = self.runner.run(["symbolic-ref", "--short", "-q", "HEAD"], cwd=repo, timeout=timeout)
        return res.stdout.strip() or None

    def tracked_entries(self, repo: Path, timeout: float = 60) -> list[TrackedEntry]:
        out = self.runner.check(["ls-files", "-s", "-z"], cwd=repo, timeout=timeout)
        entries: list[TrackedEntry] = []
        for rec in out.split("\0"):
            if not rec:
                continue
            meta, _, path = rec.partition("\t")
            mode = meta.split(" ")[0]
            entries.append(TrackedEntry(path=path, mode=mode))
        return entries

    def recent_commits(self, repo: Path, limit: int, timeout: float = 60) -> list[dict[str, str]]:
        fmt = "%H%x1f%an%x1f%aI%x1f%s%x1e"
        out = self.runner.check(["log", f"-n{limit}", f"--format={fmt}", "--no-show-signature"], cwd=repo, timeout=timeout)
        commits = []
        for rec in out.split("\x1e"):
            rec = rec.strip()
            if not rec:
                continue
            parts = rec.split("\x1f")
            if len(parts) == 4:
                commits.append({"sha": parts[0], "author": parts[1], "date": parts[2], "subject": parts[3][:300]})
        return commits


def _is_sha(value: str) -> bool:
    return len(value) in (40, 64) and all(c in "0123456789abcdef" for c in value)


def rmtree_safe(path: Path) -> None:
    """Remove a directory tree, clearing read-only bits (Git object files on Windows)."""

    def _onexc(func, p, _exc):  # type: ignore[no-untyped-def]
        try:
            os.chmod(p, 0o700)
            func(p)
        except OSError:
            pass

    if path.exists():
        shutil.rmtree(path, onexc=_onexc)
