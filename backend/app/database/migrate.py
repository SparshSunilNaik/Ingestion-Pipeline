"""Run Alembic migrations programmatically (used at startup and in tests)."""

from __future__ import annotations

from alembic import command
from alembic.config import Config

from app.core.config import BACKEND_ROOT


def upgrade_database(url: str) -> None:
    cfg = Config(str(BACKEND_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    cfg.attributes["configure_logger"] = False
    command.upgrade(cfg, "head")
