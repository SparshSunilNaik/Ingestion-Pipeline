"""Agent job end-to-end through a mocked OpenCode HTTP server (httpx MockTransport)."""

import json

import httpx
from sqlalchemy import select

from app.agents.opencode_adapter import OpenCodeAdapter
from app.agents.service import run_agent_job, set_selected_model
from app.database.models import Job, Report, Symbol
from app.ingestion import jobs
from tests.integration.helpers import ready_snapshot


class FakeRuntime:
    enabled = True

    def __init__(self, handler) -> None:
        self.handler = handler

    def adapter(self, timeout=None):
        return OpenCodeAdapter("http://127.0.0.1:1", "opencode", "pw", transport=httpx.MockTransport(self.handler))


MODELS = {"location": {"directory": "x"}, "data": [{"id": "gpt-5.6-terra", "providerID": "openai", "name": "GPT-5.6 Terra", "enabled": True}]}


def test_agent_job_produces_validated_report(session, pipeline, sample_remote) -> None:
    snap = ready_snapshot(session, pipeline)
    sym_ev = session.scalar(select(Symbol.evidence_id).where(Symbol.snapshot_id == snap.id, Symbol.name == "InventoryService"))
    seen_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_paths.append(f"{request.method} {request.url.path}")
        if request.url.path == "/api/model":
            return httpx.Response(200, json=MODELS)
        body = json.loads(request.content)
        assert body["model"] == {"providerID": "openai", "id": "gpt-5.6-terra"}
        text = json.dumps(
            {
                "action": "final",
                "report": {
                    "sections": [
                        {"title": "Purpose", "claims": [{"statement": "Tracks inventory items", "evidence_ids": [sym_ev], "confidence": "high"}]},
                    ]
                },
            }
        )
        return httpx.Response(200, json={"data": {"text": text}})

    jobs.create_agent_job(session, snap.id, snap.repository_id, "openai/gpt-5.6-terra")
    session.commit()
    jid = jobs.claim_next_job(session, "w", 60)
    run_agent_job(session, FakeRuntime(handler), jid)
    j = session.get(Job, jid, populate_existing=True)
    assert j.status == "succeeded", j.error_message
    rep = session.scalar(select(Report).where(Report.snapshot_id == snap.id, Report.kind == "agent"))
    assert rep.model == "openai/gpt-5.6-terra"
    narrative = rep.content["agent_narrative"]
    assert narrative[0]["claims"][0]["basis"] == "source_evidence"
    assert rep.usage["validation"]["unsupported_claims"] == 0
    assert "## Agent narrative" in rep.markdown
    assert set(seen_paths) <= {"GET /api/model", "POST /api/experimental/generate"}


def test_agent_job_fails_clearly_when_model_missing(session, pipeline, sample_remote) -> None:
    snap = ready_snapshot(session, pipeline)
    set_selected_model(session, "openai/gpt-5.6-terra")
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, json={"location": {"directory": "x"}, "data": [{"id": "other", "providerID": "openai", "name": "Other", "enabled": True}]})

    jobs.create_agent_job(session, snap.id, snap.repository_id, "openai/gpt-5.6-terra")
    session.commit()
    jid = jobs.claim_next_job(session, "w", 60)
    run_agent_job(session, FakeRuntime(handler), jid)
    j = session.get(Job, jid, populate_existing=True)
    assert j.status == "failed" and "not available" in j.error_message
    assert "/api/experimental/generate" not in calls  # never silently switched to another model
