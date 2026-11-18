"""Application configuration.

All settings can be overridden with environment variables prefixed ``IP_``
(for example ``IP_DATA_DIR``) or a ``.env`` file in the backend directory.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parents[2]


class RepositoryLimits(BaseSettings):
    """Configurable acquisition and analysis limits (starting values, not universal truths)."""

    model_config = SettingsConfigDict(env_prefix="IP_LIMIT_", extra="ignore")

    max_analyzed_files: int = 1000
    max_file_bytes: int = 200 * 1024
    max_total_source_bytes: int = 10 * 1024 * 1024
    max_commits: int = 100
    clone_timeout_seconds: int = 180
    max_repo_storage_bytes: int = 500 * 1024 * 1024
    max_tracked_files: int = 50_000
    git_memory_mb: int = 2048  # per git process (Windows Job Object / POSIX RLIMIT_AS)
    git_max_processes: int = 32


class OpenCodeSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="IP_OPENCODE_", extra="ignore")

    # "managed": the backend spawns its own private `opencode serve` process.
    # "external": connect to an already running server at ``base_url``.
    # "disabled": agent features are turned off.
    mode: str = "managed"
    base_url: str = "http://127.0.0.1:47900"
    username: str = "opencode"
    password: SecretStr | None = None
    executable: str = "opencode"
    port: int = 47900
    default_model: str = "openai/gpt-5.6-terra"
    request_timeout_seconds: float = 180.0
    startup_timeout_seconds: float = 20.0


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="IP_", env_file=str(BACKEND_ROOT / ".env"), extra="ignore")

    app_name: str = "Ingestion-Pipeline"
    environment: str = "development"
    data_dir: Path = BACKEND_ROOT / "data"
    database_url: str | None = None
    log_level: str = "INFO"
    log_json: bool = False
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000", "http://127.0.0.1:3000"])
    start_worker: bool = True  # legacy switch; False forces worker_mode="none"
    worker_poll_seconds: float = 1.0
    job_lease_seconds: int = 120
    # Only "https" is allowed in production. Tests may set "file" to clone local fixtures.
    git_allowed_protocols: str = "https"
    git_executable: str = "git"
    # Authentication: "token" (default) or "disabled" (tests / trusted single-user setups only).
    auth_mode: str = "token"
    api_token: SecretStr | None = None  # optional explicit token; otherwise generated into <data_dir>/api-token
    session_ttl_hours: int = 12
    max_request_bytes: int = 256 * 1024
    allowed_hosts: list[str] = Field(default_factory=lambda: ["localhost", "127.0.0.1", "[::1]", "testserver"])
    # Worker: "subprocess" (API supervises a separate worker process), "inprocess" (thread), "external", "none".
    worker_mode: str = "subprocess"
    job_timeout_seconds: dict[str, int] = Field(default_factory=lambda: {"ingest": 1200, "agent_report": 900, "qa": 600, "selftest": 60})
    job_cancel_grace_seconds: float = 15.0
    enable_selftest_jobs: bool = False

    limits: RepositoryLimits = Field(default_factory=RepositoryLimits)
    opencode: OpenCodeSettings = Field(default_factory=OpenCodeSettings)

    @property
    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite:///{(self.data_dir / 'ingestion.db').as_posix()}"

    @property
    def snapshots_dir(self) -> Path:
        return self.data_dir / "snapshots"

    @property
    def staging_dir(self) -> Path:
        return self.data_dir / "staging"

    @property
    def git_sandbox_dir(self) -> Path:
        return self.data_dir / "git-sandbox"

    @property
    def opencode_workdir(self) -> Path:
        return self.data_dir / "opencode-sandbox"

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.snapshots_dir, self.staging_dir, self.git_sandbox_dir, self.opencode_workdir):
            d.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()
