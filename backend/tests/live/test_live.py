"""Opt-in tests against real external services. Never run in CI.

Enable with:  $env:IP_LIVE_TESTS = "1"   (PowerShell)
"""

import os

import pytest

from app.core.config import RepositoryLimits, Settings
from app.ingestion.pipeline import IngestionPipeline
from tests.integration.helpers import ingest

LIVE = os.environ.get("IP_LIVE_TESTS") == "1"
pytestmark = pytest.mark.skipif(not LIVE, reason="set IP_LIVE_TESTS=1 to run live tests")

LIVE_REPO = os.environ.get("IP_LIVE_REPO", "https://github.com/pallets/itsdangerous")


@pytest.mark.live_github
def test_live_github_ingestion(session, settings: Settings) -> None:
    settings.git_allowed_protocols = "https"
    settings.limits = RepositoryLimits()
    job = ingest(session, IngestionPipeline(settings), LIVE_REPO)
    assert job.status == "succeeded", job.error_message
    assert job.snapshot_id


@pytest.mark.live_opencode
def test_live_opencode_generate(settings: Settings) -> None:
    from app.agents.runtime import OpenCodeRuntime

    settings.opencode.mode = "managed"
    settings.opencode.port = int(os.environ.get("IP_LIVE_OPENCODE_PORT", "47901"))
    rt = OpenCodeRuntime(settings)
    try:
        assert rt.status().available, rt.last_error
        a = rt.adapter()
        model = a.resolve_model(settings.opencode.default_model)
        res = a.generate("Reply with exactly the word: PONG", model.id)
        assert "PONG" in res.text
        a.close()
    finally:
        rt.stop()
