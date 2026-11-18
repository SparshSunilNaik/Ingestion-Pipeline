"""Repository-intelligence benchmark over controlled fixtures with hand-written ground truth.

    uv run python -m app.bench                 # deterministic metrics (no network, no model)
    uv run python -m app.bench --live          # also a bounded live Q&A claim-support check via OpenCode

Writes JSON to stdout (and to --out if given).
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
import time
import tracemalloc
from pathlib import Path
from typing import Any

from sqlalchemy import select

from app.core.config import BACKEND_ROOT, RepositoryLimits, Settings
from app.database.engine import init_engine, session_factory
from app.database.migrate import upgrade_database
from app.database.models import Dependency, Evidence, Finding, GraphEdge, GraphNode, Job, Report, Snapshot, Symbol
from app.evidence.verifier import SnapshotReader, verify_evidence
from app.graph.queries import entry_points, load_index, trace_flow
from app.ingestion import jobs as jobstore
from app.ingestion.pipeline import IngestionPipeline, run_ingest
from app.search.hybrid import retrieve

FIXTURES = BACKEND_ROOT.parent / "tests" / "fixtures"


def _git(cwd: Path, *args: str) -> None:
    base = [
        "git",
        "-c",
        "user.name=Bench",
        "-c",
        "user.email=bench@example.invalid",
        "-c",
        "core.autocrlf=false",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.symlinks=false",
    ]
    subprocess.run([*base, *args], cwd=cwd, check=True, capture_output=True)


def make_repo(src: Path, dest: Path) -> Path:
    shutil.copytree(src, dest)
    _git(dest, "init", "-q", "-b", "main")
    _git(dest, "add", "-A")
    _git(dest, "commit", "-q", "-m", "bench")
    return dest


def _prf(found: set, expected: set) -> dict[str, Any]:
    tp = len(found & expected)
    return {
        "precision": round(tp / len(found), 3) if found else 0.0,
        "recall": round(tp / len(expected), 3) if expected else 0.0,
        "true_positive": tp,
        "found": len(found),
        "expected": len(expected),
    }


def run(live: bool = False) -> dict[str, Any]:
    truth = json.loads((FIXTURES / "bench_expected.json").read_text(encoding="utf-8"))
    tmp = Path(tempfile.mkdtemp(prefix="ip-bench-"))
    try:
        repo = make_repo(FIXTURES / "bench_repo", tmp / "remote")
        settings = Settings(data_dir=tmp / "data", start_worker=False, git_allowed_protocols="file", auth_mode="disabled", limits=RepositoryLimits())
        settings.opencode.mode = "managed" if live else "disabled"
        settings.ensure_dirs()
        upgrade_database(settings.resolved_database_url)
        init_engine(settings.resolved_database_url)
        pipeline = IngestionPipeline(settings, clone_url_resolver=lambda ref: repo.resolve().as_uri())
        session = session_factory()()
        jobstore.create_ingest_job(session, "https://github.com/bench/bench")
        session.commit()
        jid = jobstore.claim_next_job(session, "bench", 600)
        assert jid is not None
        tracemalloc.start()
        t0 = time.perf_counter()
        run_ingest(session, pipeline, jid)
        elapsed = time.perf_counter() - t0
        _cur, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        j = session.get(Job, jid, populate_existing=True)
        assert j is not None and j.status == "succeeded", (j.error_code if j else None, j.error_message if j else None)
        snap = session.get(Snapshot, j.snapshot_id)
        assert snap is not None
        sid = snap.id

        # symbols
        found_syms = {f"{s.path}#{s.qualified_name}" for s in session.scalars(select(Symbol).where(Symbol.snapshot_id == sid))}
        found_syms = {s for s in found_syms if not s.startswith(("README", "pyproject"))}
        symbols = _prf(found_syms, set(truth["symbols"]))

        # relationships (resolved + ambiguous call/inherit edges between symbols)
        def norm(k: str) -> str:
            return k[4:] if k.startswith("sym:") else k

        edges = session.scalars(select(GraphEdge).where(GraphEdge.snapshot_id == sid, GraphEdge.kind.in_(["calls", "inherits"]))).all()
        found_rel = {
            (norm(e.source_key), e.kind, norm(e.target_key)) for e in edges if e.resolution in ("resolved", "ambiguous") and e.target_key.startswith("sym:")
        }
        expected_rel = {tuple(r) for r in truth["relationships"]}
        relationships: dict[str, Any] = _prf(found_rel, expected_rel)
        relationships["missed"] = sorted(" ".join(r) for r in expected_rel - found_rel)
        relationships["unexpected"] = sorted(" ".join(r) for r in found_rel - expected_rel)
        amb = {(norm(e.source_key), e.kind, norm(e.target_key)) for e in edges if e.resolution == "ambiguous"}
        ambiguity_ok = all(tuple(a) in amb for a in truth["ambiguous_expected"])
        nodes = {n.key: n for n in session.scalars(select(GraphNode).where(GraphNode.snapshot_id == sid))}
        negatives_ok = True
        for neg in truth["must_not_resolve"]:
            for e in edges:
                if (
                    norm(e.source_key) == neg["source"]
                    and e.resolution == "resolved"
                    and nodes.get(e.target_key)
                    and nodes[e.target_key].label.endswith(neg["target_label_suffix"])
                ):
                    negatives_ok = False

        # evidence validity
        reader = SnapshotReader(session, snap)
        evs = session.scalars(select(Evidence).where(Evidence.snapshot_id == sid)).all()
        valid = sum(1 for e in evs if verify_evidence(reader, e).ok)

        # routes & dependencies
        routes = {f.name for f in session.scalars(select(Finding).where(Finding.snapshot_id == sid, Finding.kind == "route"))}
        deps = {d.name: d.status for d in session.scalars(select(Dependency).where(Dependency.snapshot_id == sid))}
        dep_ok = {k: deps.get(k) == v for k, v in truth["dependencies"].items()}

        # flow
        idx = load_index(session, snap)
        ep = next(e for e in entry_points(session, snap, idx) if e["label"] == truth["flow"]["entry"])
        fl = trace_flow(idx, ep["start_key"], max_depth=6)
        reached = {s["to"]["key"][4:] for s in fl["steps"] if s["to"]["key"].startswith("sym:")}
        flow_recall = sum(1 for k in truth["flow"]["must_reach"] if k in reached) / len(truth["flow"]["must_reach"])

        # retrieval
        hits, rr = 0, 0.0
        per_query = []
        for q in truth["retrieval"]:
            res = [r["key"] for r in retrieve(session, snap, idx, q["query"], limit=5)["results"]]
            rank = res.index(q["expect"]) + 1 if q["expect"] in res else None
            per_query.append({"query": q["query"], "rank": rank})
            if rank and rank <= 3:
                hits += 1
            rr += 1 / rank if rank else 0
        # README honesty: claimed technologies must not become framework findings; README purpose labelled as docs claim
        fw = {f.name for f in session.scalars(select(Finding).where(Finding.snapshot_id == sid, Finding.kind == "framework"))}
        report = session.scalar(select(Report).where(Report.snapshot_id == sid, Report.kind == "deterministic"))
        purpose = next(s for s in report.content["overview"] if s["title"] == "Purpose") if report else {"claims": []}
        readme_claims = [c for c in purpose["claims"] if c["statement"].startswith("README states")]
        install = next(s for s in report.content["installation"] if s["title"] == "Installation instructions") if report else {"claims": []}
        result: dict[str, Any] = {
            "repository": "tests/fixtures/bench_repo",
            "analyzer_version": snap.analyzer_version,
            "symbol_extraction": symbols,
            "relationship_resolution": relationships,
            "ambiguous_dispatch_flagged": ambiguity_ok,
            "dynamic_call_not_over_resolved": negatives_ok,
            "evidence_validity": {"valid": valid, "total": len(evs), "rate": round(valid / len(evs), 3) if evs else 0.0},
            "routes": {"found": sorted(routes), "recall": round(len(routes & set(truth["routes"])) / len(truth["routes"]), 3)},
            "dependency_status_correct": dep_ok,
            "flow_tracing": {"entry": ep["label"], "must_reach_recall": round(flow_recall, 3), "steps": len(fl["steps"])},
            "retrieval": {"hit_at_3": round(hits / len(truth["retrieval"]), 3), "mrr": round(rr / len(truth["retrieval"]), 3), "per_query": per_query},
            "misleading_readme": {
                "claimed_technologies_not_reported_as_frameworks": not (set(truth["misleading_readme"]["claimed_but_absent_technologies"]) & fw),
                "readme_purpose_labelled_documentation_claim": bool(readme_claims) and all(c["basis"] == "documentation_claim" for c in readme_claims),
            },
            "missing_documentation_reported": any(c["basis"] == "unknown" for c in install["claims"]),
            "coverage": {k: snap.coverage.get(k) for k in ("tracked_files", "analyzed_files", "is_partial")},
            "runtime_seconds": round(elapsed, 3),
            "peak_python_memory_mb": round(peak / 1024 / 1024, 2),
        }
        if live:
            result["live_qa"] = _live_qa(session, snap, settings)
        session.close()
        return result
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _live_qa(session, snap: Snapshot, settings: Settings) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    from app.agents.qa import answer_question
    from app.agents.runtime import OpenCodeRuntime
    from app.database.models import Conversation, Message

    rt = OpenCodeRuntime(settings)
    settings.opencode.port = 47911
    try:
        adapter = rt.adapter()
        model = adapter.resolve_model(settings.opencode.default_model).id
        conv = Conversation(snapshot_id=snap.id, title="bench", model=model)
        session.add(conv)
        session.commit()
        out = []
        for q in ["What happens when a user logs in via POST /login?", "Which code would be affected if Account.validate changes?"]:
            m = Message(conversation_id=conv.id, role="user", content=q, status="complete", payload={})
            session.add(m)
            session.commit()
            res = answer_question(session, snap, conv, m, lambda p: (lambda r: (r.text, {"latency_ms": r.latency_ms}))(adapter.generate(p, model)))
            claims = res["claims"]
            out.append(
                {"question": q, "claims": len(claims), "supported": sum(1 for c in claims if c["basis"] != "unsupported"), "grounding": res["grounding"]}
            )
            session.add(Message(conversation_id=conv.id, role="assistant", content=res["summary"], status="complete", payload={"claims": claims}))
            session.commit()
        total = sum(o["claims"] for o in out)
        return {"model": model, "questions": out, "claim_support_rate": round(sum(o["supported"] for o in out) / total, 3) if total else None}
    finally:
        rt.stop()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--out")
    args = ap.parse_args()
    res = run(live=args.live)
    text = json.dumps(res, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
