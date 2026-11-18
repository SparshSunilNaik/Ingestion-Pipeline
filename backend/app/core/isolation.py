"""Child-process resource isolation.

Windows: each child is started suspended, assigned to a Job Object, then resumed. The job enforces
  * a per-process committed-memory limit (JOB_OBJECT_LIMIT_PROCESS_MEMORY),
  * a maximum number of active processes (JOB_OBJECT_LIMIT_ACTIVE_PROCESS),
  * kill-on-close: when the owning handle closes (including when this Python process dies), every
    process in the job is terminated, so no orphaned git/OpenCode/worker processes survive.
POSIX: RLIMIT_AS / RLIMIT_NPROC are applied in the child before exec, and a new session is created
  so the whole process group can be killed.

This is resource isolation, NOT a security sandbox: children keep the user's filesystem and network
access. See docs/SECURITY.md for residual risks.
"""

from __future__ import annotations

import contextlib
import ctypes
import os
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.core.logging import get_logger

log = get_logger(__name__)

IS_WINDOWS = sys.platform == "win32"

if IS_WINDOWS:
    from ctypes import wintypes

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined,unused-ignore]
    _ntdll = ctypes.WinDLL("ntdll")  # type: ignore[attr-defined,unused-ignore]

    JobObjectExtendedLimitInformation = 9
    JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008
    JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400
    CREATE_SUSPENDED = 0x00000004
    PROCESS_ALL_ACCESS = 0x1F0FFF

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [
            (n, ctypes.c_ulonglong)
            for n in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")
        ]

    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    _kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    _kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    _kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    _kernel32.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
    _kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    _kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _kernel32.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
    _ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]


@dataclass
class Limits:
    memory_bytes: int | None = None  # per process
    max_processes: int | None = None
    kill_on_close: bool = True


class JobObject:
    """Windows Job Object wrapper (no-op container on other platforms)."""

    def __init__(self, limits: Limits) -> None:
        self.limits = limits
        self.handle: Any = None
        if not IS_WINDOWS:
            return
        h = _kernel32.CreateJobObjectW(None, None)
        if not h:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")  # type: ignore[attr-defined,unused-ignore]
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        flags = 0
        if limits.kill_on_close:
            flags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if limits.memory_bytes:
            flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY
            info.ProcessMemoryLimit = limits.memory_bytes
        if limits.max_processes:
            flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            info.BasicLimitInformation.ActiveProcessLimit = limits.max_processes
        info.BasicLimitInformation.LimitFlags = flags | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
        if not _kernel32.SetInformationJobObject(h, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)):
            err = ctypes.get_last_error()  # type: ignore[attr-defined,unused-ignore]
            _kernel32.CloseHandle(h)
            raise OSError(err, "SetInformationJobObject failed")
        self.handle = h

    def assign(self, process_handle: int) -> None:
        if IS_WINDOWS and self.handle and not _kernel32.AssignProcessToJobObject(self.handle, process_handle):
            raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")  # type: ignore[attr-defined,unused-ignore]

    def query_limits(self) -> dict[str, int]:
        if not (IS_WINDOWS and self.handle):
            return {}
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        _kernel32.QueryInformationJobObject(self.handle, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info), None)
        return {
            "limit_flags": int(info.BasicLimitInformation.LimitFlags),
            "process_memory_limit": int(info.ProcessMemoryLimit),
            "active_process_limit": int(info.BasicLimitInformation.ActiveProcessLimit),
            "peak_process_memory_used": int(info.PeakProcessMemoryUsed),
        }

    def close(self) -> None:
        """Closing a kill-on-close job terminates every process still inside it."""
        if IS_WINDOWS and self.handle:
            _kernel32.CloseHandle(self.handle)
            self.handle = None

    def __del__(self) -> None:  # pragma: no cover - best effort
        with contextlib.suppress(Exception):
            self.close()


def _posix_preexec(limits: Limits) -> Callable[[], None]:
    def apply() -> None:  # pragma: no cover - runs in the child
        if sys.platform == "win32":
            return
        import resource

        if limits.memory_bytes:
            resource.setrlimit(resource.RLIMIT_AS, (limits.memory_bytes, limits.memory_bytes))
        if limits.max_processes and hasattr(resource, "RLIMIT_NPROC"):
            _soft, hard = resource.getrlimit(resource.RLIMIT_NPROC)
            cap = limits.max_processes + 512  # NPROC counts all of the user's processes; keep generous
            resource.setrlimit(resource.RLIMIT_NPROC, (min(cap, hard) if hard > 0 else cap, hard))

    return apply


def popen_limited(cmd: list[str], limits: Limits, **kwargs: Any) -> tuple[subprocess.Popen[bytes], JobObject | None]:
    """Start `cmd` with resource limits. Returns (process, job). Keep `job` alive as long as the process runs."""
    if IS_WINDOWS:
        job = JobObject(limits)
        flags = kwargs.pop("creationflags", 0) | CREATE_SUSPENDED
        proc = subprocess.Popen(cmd, creationflags=flags, **kwargs)
        try:
            job.assign(int(proc._handle))  # type: ignore[attr-defined]
        except OSError:
            proc.kill()
            job.close()
            raise
        _ntdll.NtResumeProcess(int(proc._handle))  # type: ignore[attr-defined]
        return proc, job
    kwargs.setdefault("start_new_session", True)
    proc = subprocess.Popen(cmd, preexec_fn=_posix_preexec(limits), **kwargs)
    return proc, None


def is_process_in_any_job(pid: int) -> bool | None:
    if not IS_WINDOWS:
        return None
    h = _kernel32.OpenProcess(PROCESS_ALL_ACCESS, False, pid)
    if not h:
        return None
    try:
        result = wintypes.BOOL()
        _kernel32.IsProcessInJob(h, None, ctypes.byref(result))
        return bool(result.value)
    finally:
        _kernel32.CloseHandle(h)


def restrict_to_current_user(path: os.PathLike[str] | str) -> bool:
    """Best-effort: make a secret file/dir readable only by the current user. Returns True on success."""
    p = os.fspath(path)
    if not IS_WINDOWS:
        try:
            os.chmod(p, 0o700 if os.path.isdir(p) else 0o600)
            return True
        except OSError:
            return False
    user = os.environ.get("USERNAME")
    if not user:
        return False
    domain = os.environ.get("USERDOMAIN")
    principal = f"{domain}\\{user}" if domain else user
    res = subprocess.run(["icacls", p, "/inheritance:r", "/grant:r", f"{principal}:F"], capture_output=True, check=False)
    if res.returncode != 0:
        log.warning("could not restrict ACL on %s", p)
    return res.returncode == 0
