"""Semantic-correctness evaluation for repository explanations.

Three separate measurements, never merged:

* **Deterministic checks** (automatic): expected-fact keyword coverage, required evidence cited,
  plausible-but-wrong statements asserted, unsupported claims, uncertainty handling. These are
  heuristics that *flag answers for review*; they do not prove an explanation is correct.
* **Citation validity** (automatic): every cited evidence ID exists and re-verifies — reported by the
  Q&A pipeline itself, and only copied here.
* **Human review** (manual): a reviewer records `correct | partially_correct | incorrect` per answer in a
  reviews file. Only these verdicts may be reported as semantic accuracy.

Modes::

    uv run python -m app.evaluation.semantic --mode reference            # scorer self-test, no model (CI)
    uv run python -m app.evaluation.semantic --mode live --out run.json  # real Q&A through OpenCode
    uv run python -m app.evaluation.semantic --summarize run.json --reviews reviews.json
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.core.config import BACKEND_ROOT

DATASET = BACKEND_ROOT.parent / "tests" / "fixtures" / "semantic_eval.json"
HUMAN_VERDICTS = ("correct", "partially_correct", "incorrect")
_NEGATION = re.compile(
    r"\b(no|not|never|none|without|cannot|absent|neither|nor)\b|n't\b|readme (states|claims|mentions|says)|documentation (states|claims)",
    re.I,
)
_UNCERTAIN = re.compile(
    r"cannot be determined|can't be determined|not enough evidence|insufficient evidence|unknown|no evidence|not found|could not find|unclear",
    re.I,
)


def load_dataset(path: Path = DATASET) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    ids = [i["id"] for i in data["items"]]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate item ids in semantic dataset")
    return data


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", text) if s.strip()]


def score_answer(item: dict[str, Any], text: str, cited_paths: list[str], grounding: str, unsupported_claims: int = 0) -> dict[str, Any]:
    """Deterministic checks for one answer. Returns flags; `automatic_verdict` is a triage label only."""
    low = text.lower()
    facts = []
    for f in item["expected_facts"]:
        hit = all(any(term.lower() in low for term in group) for group in f["all_of"])
        facts.append({"fact": f["fact"], "mentioned": hit})
    cited = set(cited_paths)
    required = item["required_evidence"]
    evidence_hit = [p for p in required if p in cited]
    asserted_wrong = []
    for w in item["plausible_wrong"]:
        for sentence in _sentences(text):
            if any(re.search(p, sentence, re.I) for p in w["patterns"]) and not _NEGATION.search(sentence):
                asserted_wrong.append({"claim": w["claim"], "sentence": sentence[:240]})
                break
    if item.get("expect_uncertainty"):
        absence = any(a in low for a in item.get("accept_absence_statement", []))
        uncertainty_ok = grounding == "insufficient_evidence" or bool(_UNCERTAIN.search(text)) or absence
    else:
        uncertainty_ok = grounding != "insufficient_evidence"
    fact_cov = round(sum(f["mentioned"] for f in facts) / len(facts), 3) if facts else None
    ev_cov = round(len(evidence_hit) / len(required), 3) if required else None
    if asserted_wrong or not uncertainty_ok:
        verdict = "fail"
    elif (fact_cov is None or fact_cov >= 0.75) and (ev_cov is None or ev_cov >= 0.5) and unsupported_claims == 0:
        verdict = "pass"
    else:
        verdict = "needs_review"
    return {
        "expected_fact_coverage": fact_cov,
        "facts": facts,
        "required_evidence_cited": ev_cov,
        "missing_required_evidence": [p for p in required if p not in cited],
        "plausible_wrong_asserted": asserted_wrong,
        "unsupported_claims": unsupported_claims,
        "uncertainty_handled": uncertainty_ok,
        "automatic_verdict": verdict,
    }


def run_reference(dataset: dict[str, Any]) -> dict[str, Any]:
    """Score the hand-written reference answers. Correct references must pass; plausible-wrong ones must fail."""
    rows = []
    for item in dataset["items"]:
        for kind, ref in item["reference_answers"].items():
            s = score_answer(item, ref["text"], ref["cited_paths"], ref["grounding"])
            rows.append({"id": item["id"], "reference": kind, **s})
    ok = all((r["automatic_verdict"] == "pass") == (r["reference"] == "correct") for r in rows)
    return {"mode": "reference", "dataset_version": dataset["version"], "scorer_consistent": ok, "results": rows}


def run_live(dataset: dict[str, Any], model: str | None = None, only: list[str] | None = None) -> dict[str, Any]:  # pragma: no cover - needs a model
    from sqlalchemy import select

    from app.agents.qa import answer_question
    from app.agents.runtime import OpenCodeRuntime
    from app.bench import FIXTURES, make_repo
    from app.core.config import RepositoryLimits, Settings
    from app.database.engine import init_engine, session_factory
    from app.database.migrate import upgrade_database
    from app.database.models import Conversation, Evidence, Job, Message, Snapshot
    from app.ingestion import jobs as jobstore
    from app.ingestion.pipeline import IngestionPipeline, run_ingest

    items = [i for i in dataset["items"] if not only or i["id"] in only]
    tmp = Path(tempfile.mkdtemp(prefix="ip-semeval-"))
    try:
        remotes = {f: make_repo(FIXTURES / f"{f}_repo", tmp / f"remote-{f}") for f in sorted({i["fixture"] for i in items})}
        settings = Settings(data_dir=tmp / "data", start_worker=False, git_allowed_protocols="file", auth_mode="disabled", limits=RepositoryLimits())
        settings.opencode.mode = "managed"
        settings.opencode.port = 47912
        settings.ensure_dirs()
        upgrade_database(settings.resolved_database_url)
        init_engine(settings.resolved_database_url)
        pipeline = IngestionPipeline(settings, clone_url_resolver=lambda ref: remotes[ref.name].resolve().as_uri())
        session = session_factory()()
        snaps: dict[str, Snapshot] = {}
        for f in remotes:
            jobstore.create_ingest_job(session, f"https://github.com/semeval/{f}")
            session.commit()
            jid = jobstore.claim_next_job(session, "semeval", 600)
            assert jid is not None
            run_ingest(session, pipeline, jid)
            job = session.get(Job, jid, populate_existing=True)
            assert job is not None and job.status == "succeeded", job.error_message if job else None
            snap = session.get(Snapshot, job.snapshot_id)
            assert snap is not None
            snaps[f] = snap
        rt = OpenCodeRuntime(settings)
        try:
            adapter = rt.adapter()
            model_id = adapter.resolve_model(model or settings.opencode.default_model).id
            rows = []
            for item in items:
                snap = snaps[item["fixture"]]
                conv = Conversation(snapshot_id=snap.id, title=f"semeval {item['id']}", model=model_id)
                session.add(conv)
                session.commit()
                msg = Message(conversation_id=conv.id, role="user", content=item["question"], status="complete", payload={})
                session.add(msg)
                session.commit()
                res = answer_question(session, snap, conv, msg, lambda p: (lambda r: (r.text, {"latency_ms": r.latency_ms}))(adapter.generate(p, model_id)))
                claims = res["claims"]
                ids = {i for c in claims for i in c.get("evidence_ids", [])}
                paths = sorted({e.path for e in session.scalars(select(Evidence).where(Evidence.id.in_(ids)))}) if ids else []
                text = "\n".join([res["summary"], *(c["statement"] for c in claims)])
                unsupported = sum(1 for c in claims if c["basis"] == "unsupported")
                rows.append(
                    {
                        "id": item["id"],
                        "fixture": item["fixture"],
                        "commit_sha": snap.commit_sha,
                        "question": item["question"],
                        "answer": res["summary"],
                        "claims": [{"statement": c["statement"], "basis": c["basis"], "evidence_ids": c.get("evidence_ids", [])} for c in claims],
                        "cited_paths": paths,
                        "grounding": res["grounding"],
                        "citation_validity": {"claims": len(claims), "with_valid_evidence": len(claims) - unsupported},
                        **score_answer(item, text, paths, res["grounding"], unsupported),
                    }
                )
            return {
                "mode": "live",
                "model": model_id,
                "analyzer_version": next(iter(snaps.values())).analyzer_version,
                "commits": {f: s.commit_sha for f, s in snaps.items()},
                "dataset_version": dataset["version"],
                "configuration": {"qa_max_rounds": 3, "gateway_max_requests": 20, "runtime": "opencode generate (tool-less)"},
                "run_at": datetime.now(UTC).isoformat(timespec="seconds"),
                "results": rows,
            }
        finally:
            rt.stop()
            session.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def summarize(run: dict[str, Any], reviews: dict[str, Any] | None = None) -> dict[str, Any]:
    """Aggregate a run. Human-reviewed semantic accuracy is reported only for reviewed answers."""
    rows = run["results"]
    auto: dict[str, int] = {}
    for r in rows:
        auto[r["automatic_verdict"]] = auto.get(r["automatic_verdict"], 0) + 1
    covs = [r["expected_fact_coverage"] for r in rows if r.get("expected_fact_coverage") is not None]
    out: dict[str, Any] = {
        "answers": len(rows),
        "automatic_triage": auto,
        "mean_expected_fact_coverage": round(sum(covs) / len(covs), 3) if covs else None,
        "plausible_wrong_asserted": sum(1 for r in rows if r["plausible_wrong_asserted"]),
        "uncertainty_handled": sum(1 for r in rows if r["uncertainty_handled"]),
    }
    if "citation_validity" in (rows[0] if rows else {}):
        total = sum(r["citation_validity"]["claims"] for r in rows)
        valid = sum(r["citation_validity"]["with_valid_evidence"] for r in rows)
        out["citation_validity"] = {"claims": total, "with_valid_evidence": valid, "note": "evidence exists and re-verifies; NOT semantic accuracy"}
    verdicts = {k: v["verdict"] for k, v in (reviews or {}).get("reviews", {}).items() if v.get("verdict") in HUMAN_VERDICTS}
    reviewed = [r for r in rows if r["id"] in verdicts]
    out["human_review"] = {
        "reviewed": len(reviewed),
        "unreviewed": len(rows) - len(reviewed),
        **{v: sum(1 for r in reviewed if verdicts[r["id"]] == v) for v in HUMAN_VERDICTS},
        "semantic_accuracy": round(sum(1 for r in reviewed if verdicts[r["id"]] == "correct") / len(reviewed), 3) if reviewed else None,
        "reviewer": (reviews or {}).get("reviewer"),
    }
    return out


def review_sheet(run: dict[str, Any]) -> str:
    """Markdown sheet for a human reviewer, plus a JSON skeleton to fill in."""
    lines = [f"# Semantic review — model {run.get('model')}, analyzer {run.get('analyzer_version')}", ""]
    for r in run["results"]:
        lines += [
            f"## {r['id']} ({r.get('commit_sha', '')[:12]})",
            f"**Question:** {r['question']}",
            "",
            r["answer"],
            "",
            *[f"- [{c['basis']}] {c['statement']}" for c in r["claims"]],
            "",
            f"Automatic triage: {r['automatic_verdict']} (fact coverage {r['expected_fact_coverage']}, evidence {r['required_evidence_cited']})",
            "",
            "Verdict (correct / partially_correct / incorrect): ______",
            "",
        ]
    return "\n".join(lines)


def main() -> None:  # pragma: no cover - CLI
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("reference", "live"), default="reference")
    ap.add_argument("--model", help="OpenCode model ID (default: configured model; never substituted)")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--out")
    ap.add_argument("--summarize", help="summarize an existing run JSON instead of running")
    ap.add_argument("--reviews", help="human reviews JSON: {reviewer, reviews: {item_id: {verdict, notes}}}")
    args = ap.parse_args()
    dataset = load_dataset()
    if args.summarize:
        run = json.loads(Path(args.summarize).read_text(encoding="utf-8"))
        reviews = json.loads(Path(args.reviews).read_text(encoding="utf-8")) if args.reviews else None
        print(json.dumps(summarize(run, reviews), indent=2))
        return
    res = run_reference(dataset) if args.mode == "reference" else run_live(dataset, args.model, args.only)
    if args.mode == "live":
        res["summary"] = summarize(res)
    text = json.dumps(res, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        if args.mode == "live":
            Path(args.out).with_suffix(".review.md").write_text(review_sheet(res), encoding="utf-8")
            skeleton = {"reviewer": None, "reviews": {r["id"]: {"verdict": None, "notes": ""} for r in res["results"]}}
            Path(args.out).with_suffix(".reviews.json").write_text(json.dumps(skeleton, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
