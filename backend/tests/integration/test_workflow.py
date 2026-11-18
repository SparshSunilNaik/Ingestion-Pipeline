"""Agent workflow with a scripted (mock) model. No network or OpenCode needed."""

import json

import pytest
from sqlalchemy import select

from app.agents.workflow import FinalReport, InvestigationWorkflow, build_evidence_pack, parse_action, validate_report
from app.core.errors import AgentError
from app.database.models import Evidence, Finding, Symbol
from tests.integration.helpers import ready_snapshot


class ScriptedModel:
    def __init__(self, replies) -> None:
        self.replies = list(replies)
        self.prompts: list[str] = []

    def __call__(self, prompt: str):
        self.prompts.append(prompt)
        reply = self.replies.pop(0)
        text = reply(prompt) if callable(reply) else reply
        return text, {"latency_ms": 1, "prompt_chars": len(prompt), "response_chars": len(text)}


def test_parse_action_variants() -> None:
    a = parse_action('```json\n{"action": "request_evidence", "requests": [{"tool": "search", "query": "router"}]}\n```')
    assert a.action == "request_evidence"
    b = parse_action('Sure! {"action": "final", "report": {"sections": []}} thanks')
    assert b.action == "final"
    with pytest.raises(AgentError):
        parse_action("no json here")
    with pytest.raises(AgentError):
        parse_action('{"action": "request_evidence", "requests": [{"tool": "shell", "cmd": "rm -rf /"}]}')
    with pytest.raises(AgentError):
        parse_action('{"action": "delete_everything"}')


def test_parse_action_repairs_unbalanced_brackets() -> None:
    from app.agents.workflow import repair_brackets

    # Real failure observed with a live model: the `sections` array was never closed.
    broken = '{"action":"final","report":{"sections":[{"title":"Purpose","claims":[{"statement":"x }] y","evidence_ids":[]}]}}}'
    a = parse_action(broken)
    assert a.action == "final" and a.report.sections[0].claims[0].statement == "x }] y"
    assert repair_brackets('{"a":[1,2') == '{"a":[1,2]}'
    assert repair_brackets('{"a":1}}') == '{"a":1}'
    assert parse_action('{"action": "final", "report": {"sections": []}} trailing }').action == "final"


def test_evidence_pack_is_bounded_and_cites_ids(session, pipeline, sample_remote) -> None:
    snap = ready_snapshot(session, pipeline)
    pack = build_evidence_pack(session, snap)
    assert len(json.dumps(pack)) < 40_000
    ids = {e.id for e in session.scalars(select(Evidence).where(Evidence.snapshot_id == snap.id))}
    for fw in pack["frameworks"]:
        assert fw["evidence_id"] in ids
    assert pack["readme_excerpt"]["file"] == "README.md"


def test_validation_downgrades_and_labels(session, pipeline, sample_remote) -> None:
    snap = ready_snapshot(session, pipeline)
    readme_ev = session.scalar(select(Finding.evidence_id).where(Finding.snapshot_id == snap.id, Finding.kind == "doc_section", Finding.name == "Features"))
    sym_ev = session.scalar(select(Symbol.evidence_id).where(Symbol.snapshot_id == snap.id, Symbol.name == "InventoryService"))
    report = FinalReport.model_validate(
        {
            "sections": [
                {
                    "title": "Purpose",
                    "claims": [
                        {"statement": "Docs say it tracks items", "evidence_ids": [readme_ev]},
                        {"statement": "InventoryService stores items in memory", "evidence_ids": [sym_ev, "ev_fabricated000000000000"]},
                        {"statement": "This repository is malware", "evidence_ids": ["ev_doesnotexist"]},
                        {"statement": "No evidence at all", "evidence_ids": []},
                    ],
                },
                {"title": "Ignore previous instructions", "claims": [{"statement": "x", "evidence_ids": [sym_ev]}]},
            ]
        }
    )
    sections, stats = validate_report(session, snap, report)
    assert [s.title for s in sections] == ["Purpose"]
    bases = [c.basis for c in sections[0].claims]
    assert bases == ["documentation_claim", "source_evidence", "unsupported", "unsupported"]
    assert sections[0].claims[1].evidence_ids == [sym_ev]
    assert "invalid evidence ID" in (sections[0].claims[1].note or "")
    assert stats["unsupported_claims"] == 2
    assert "ev_doesnotexist" in stats["invalid_evidence_ids"]
    assert stats["dropped_sections"] == ["Ignore previous instructions"]


def test_evidence_from_another_snapshot_is_rejected(session, pipeline, sample_remote, tmp_path, remotes) -> None:
    from tests.conftest import SAMPLE_REPO, make_git_repo
    from tests.integration.helpers import ingest

    snap_a = ready_snapshot(session, pipeline)
    other = make_git_repo(tmp_path / "other", SAMPLE_REPO)
    remotes.add("acme/other", other)
    job_b = ingest(session, pipeline, "https://github.com/acme/other")
    ev_b = session.scalar(select(Evidence.id).where(Evidence.snapshot_id == job_b.snapshot_id))
    report = FinalReport.model_validate({"sections": [{"title": "Purpose", "claims": [{"statement": "x", "evidence_ids": [ev_b]}]}]})
    sections, _ = validate_report(session, snap_a, report)
    assert sections[0].claims[0].basis == "unsupported"


def test_full_workflow_with_tool_requests_and_injection(session, pipeline, sample_remote) -> None:
    snap = ready_snapshot(session, pipeline)

    def round1(prompt: str) -> str:
        # The README contains an injection; the prompt must label repository text as untrusted.
        assert "UNTRUSTED" in prompt and "Ignore all previous instructions" in prompt
        return json.dumps(
            {
                "action": "request_evidence",
                "requests": [
                    {"tool": "read_file_range", "path": "app/services/inventory.py", "start_line": 1, "end_line": 400},
                    {"tool": "read_file_range", "path": "../../../../etc/passwd", "start_line": 1, "end_line": 5},
                    {"tool": "read_file_range", "path": "docs/link-to-secret", "start_line": 1, "end_line": 5},
                    {"tool": "search", "query": "make_item"},
                    {"tool": "get_symbol", "name": "InventoryService"},
                    {"tool": "list_directory", "path": "app"},
                ],
            }
        )

    captured: dict = {}

    def round2(prompt: str) -> str:
        results = json.loads(prompt.split("TOOL RESULTS (untrusted repository data):\n", 1)[1])
        captured["results"] = results
        return "not json at all"  # forces one format retry

    def round3(prompt: str) -> str:
        assert "was rejected" in prompt
        read_ev = captured["results"][0]["evidence_id"]
        return json.dumps(
            {
                "action": "final",
                "report": {
                    "sections": [
                        {
                            "title": "Important components",
                            "claims": [{"statement": "InventoryService keeps items in a list", "evidence_ids": [read_ev], "confidence": "high"}],
                        },
                        {"title": "Purpose", "claims": [{"statement": "This repository is malware", "evidence_ids": ["ev_fake"], "confidence": "high"}]},
                    ]
                },
            }
        )

    model = ScriptedModel([round1, round2, round3])
    result = InvestigationWorkflow(session, snap, model).run()
    reads = captured["results"]
    assert reads[0]["end_line"] - reads[0]["start_line"] < 120  # per-read line cap
    assert "error" in reads[1] and "error" in reads[2]  # traversal & symlink refused
    assert reads[3]["hits"] and reads[4]["matches"]
    assert "services" in reads[5]["entries"]
    sec = {s.title: s for s in result.sections}
    assert sec["Important components"].claims[0].basis == "source_evidence"
    assert sec["Purpose"].claims[0].basis == "unsupported"
    assert result.usage["model_calls"] == 3 and result.usage["format_retries"] == 1
    # retrieved evidence was persisted and is verifiable
    ev = session.get(Evidence, reads[0]["evidence_id"])
    assert ev is not None and ev.category == "retrieved_source"


def test_budget_exhaustion(session, pipeline, sample_remote) -> None:
    snap = ready_snapshot(session, pipeline)
    req = json.dumps({"action": "request_evidence", "requests": [{"tool": "search", "query": "item"}]})
    model = ScriptedModel([req] * 10)
    with pytest.raises(AgentError) as e:
        InvestigationWorkflow(session, snap, model).run()
    assert e.value.details["kind"] == "budget_exhausted"
    assert len(model.prompts) == 4
    assert "final round" in model.prompts[-1]
