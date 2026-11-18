"""The semantic evaluator's deterministic checks (no model involved)."""

from app.evaluation.semantic import load_dataset, run_reference, score_answer, summarize


def _item(item_id: str) -> dict:
    return next(i for i in load_dataset()["items"] if i["id"] == item_id)


def test_dataset_covers_several_architectures_and_uncertainty() -> None:
    items = load_dataset()["items"]
    assert len({i["fixture"] for i in items}) >= 2
    assert len({i["architecture"] for i in items}) == len(items)
    assert any(i["expect_uncertainty"] for i in items)
    assert all(i["plausible_wrong"] for i in items)


def test_reference_answers_are_scored_consistently() -> None:
    res = run_reference(load_dataset())
    assert res["scorer_consistent"], [r for r in res["results"] if (r["automatic_verdict"] == "pass") != (r["reference"] == "correct")]


def test_negated_mentions_are_not_counted_as_wrong_assertions() -> None:
    item = _item("bench-production-database")
    s = score_answer(item, "The README mentions Redis, but no Redis client appears in the code, so the database cannot be determined.", [], "grounded")
    assert s["plausible_wrong_asserted"] == [] and s["uncertainty_handled"]


def test_confident_answer_to_unanswerable_question_fails() -> None:
    item = _item("bench-production-database")
    s = score_answer(item, "The service uses SQLite for persistence.", ["svc/core/models.py"], "grounded")
    assert not s["uncertainty_handled"] and s["automatic_verdict"] == "fail"


def test_unsupported_claims_prevent_an_automatic_pass() -> None:
    item = _item("eval-go-server")
    ref = item["reference_answers"]["correct"]
    s = score_answer(item, ref["text"], ref["cited_paths"], "partially_grounded", unsupported_claims=1)
    assert s["automatic_verdict"] == "needs_review"


def test_summary_keeps_human_review_separate_from_automatic_checks() -> None:
    item = _item("eval-stock-level")
    ref = item["reference_answers"]["correct"]
    row = {"id": item["id"], **score_answer(item, ref["text"], ref["cited_paths"], "grounded"), "citation_validity": {"claims": 3, "with_valid_evidence": 3}}
    unreviewed = summarize({"results": [row]})
    assert unreviewed["human_review"]["semantic_accuracy"] is None and unreviewed["human_review"]["unreviewed"] == 1
    assert "NOT semantic accuracy" in unreviewed["citation_validity"]["note"]
    reviewed = summarize({"results": [row]}, {"reviewer": "owner", "reviews": {item["id"]: {"verdict": "partially_correct"}}})
    assert reviewed["human_review"]["semantic_accuracy"] == 0.0 and reviewed["human_review"]["partially_correct"] == 1
