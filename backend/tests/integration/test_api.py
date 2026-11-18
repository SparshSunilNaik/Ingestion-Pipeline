import pytest
from fastapi.testclient import TestClient

from app.ingestion.pipeline import IngestionPipeline
from app.ingestion.worker import Worker
from app.main import create_app


@pytest.fixture
def client(settings, remotes, sample_remote):
    pipeline = IngestionPipeline(settings, clone_url_resolver=remotes)
    app = create_app(settings, pipeline=pipeline)
    with TestClient(app, headers={"Authorization": f"Bearer {app.state.auth.token}"}) as c:
        c.worker = Worker(settings, app.state.runtime, pipeline)  # drive jobs synchronously
        yield c


def ingest(client) -> dict:
    r = client.post("/api/jobs", json={"url": "https://github.com/acme/sample"})
    assert r.status_code == 202, r.text
    job_id = r.json()["job"]["id"]
    assert client.worker.run_once() == job_id
    job = client.get(f"/api/jobs/{job_id}").json()
    assert job["status"] == "succeeded", job
    return job


def test_health_and_openapi(client) -> None:
    assert client.get("/api/health").json()["status"] == "ok"
    ready = client.get("/api/health/ready").json()
    assert ready["database"] is True and ready["git"]
    spec = client.get("/openapi.json").json()
    assert "/api/jobs" in spec["paths"] and "/api/snapshots/{snapshot_id}/graph" in spec["paths"]


def test_url_validation_and_job_errors(client) -> None:
    v = client.post("/api/repositories/validate", json={"url": "https://github.com/a/b/tree/main"}).json()
    assert v["valid"] is False and v["error"]
    v = client.post("/api/repositories/validate", json={"url": "https://github.com/a/b.git"}).json()
    assert v == {"valid": True, "canonical_url": "https://github.com/a/b", "owner": "a", "name": "b", "error": None}
    r = client.post("/api/jobs", json={"url": "https://user:pw@github.com/a/b"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_repository_url"
    assert client.get("/api/jobs/9999").status_code == 404


def test_duplicate_active_job_returns_existing(client) -> None:
    a = client.post("/api/jobs", json={"url": "https://github.com/acme/sample"})
    b = client.post("/api/jobs", json={"url": "https://github.com/acme/sample.git"})
    assert a.status_code == 202 and b.status_code == 200
    assert a.json()["job"]["id"] == b.json()["job"]["id"] and b.json()["created"] is False


def test_end_to_end_workspace(client) -> None:
    job = ingest(client)
    sid = job["snapshot_id"]
    snap = client.get(f"/api/snapshots/{sid}").json()
    assert len(snap["commit_sha"]) == 40 and snap["repository"]["owner"] == "acme"
    repos = client.get("/api/repositories").json()
    assert repos[0]["current"]["id"] == sid

    files = client.get(f"/api/snapshots/{sid}/files", params={"category": "source"}).json()
    assert files["total"] >= 8 and all(f["category"] == "source" for f in files["items"])

    src = client.get(f"/api/snapshots/{sid}/source", params={"path": "app/main.py", "start": 1, "end": 3}).json()
    assert src["lines"][0] == '"""Application entry point."""' and src["total_lines"] > 10
    assert client.get(f"/api/snapshots/{sid}/source", params={"path": "../secret"}).status_code == 404
    assert client.get(f"/api/snapshots/{sid}/source", params={"path": "docs/link-to-secret"}).status_code == 404

    syms = client.get(f"/api/snapshots/{sid}/symbols", params={"q": "Inventory"}).json()
    assert any(s["qualified_name"] == "InventoryService" for s in syms)

    g = client.get(f"/api/snapshots/{sid}/graph", params={"view": "files"}).json()
    keys = {n["key"] for n in g["nodes"]}
    assert all(e["source"] in keys and e["target"] in keys for e in g["edges"])
    assert any(e["kind"] == "imports" and e["resolution"] == "resolved" for e in g["edges"])
    gs = client.get(f"/api/snapshots/{sid}/graph", params={"view": "symbols", "path_prefix": "app/"}).json()
    assert any(e["kind"] == "calls" for e in gs["edges"])

    imp = client.get(f"/api/snapshots/{sid}/impact", params={"key": "sym:app/services/inventory.py#make_item"}).json()
    dependents = {d["key"] for d in imp["dependents"]}
    assert "sym:app/api/routes.py#create_item" in dependents
    assert "route:POST /items@app/api/routes.py:14" in dependents
    fimp = client.get(f"/api/snapshots/{sid}/impact", params={"key": "file:app/services/inventory.py"}).json()
    assert "file:app/main.py" in {d["key"] for d in fimp["dependents"]}

    deps = {(d["name"], d["status"]) for d in client.get(f"/api/snapshots/{sid}/dependencies").json()}
    assert ("fastapi", "observed_import") in deps and ("left-pad", "not_observed") in deps

    routes = client.get(f"/api/snapshots/{sid}/findings", params={"kind": "route"}).json()
    assert {r["name"] for r in routes} >= {"GET /items", "POST /items", "GET /health", "GET /api/health"}

    hits = client.get(f"/api/snapshots/{sid}/search", params={"q": "InventoryService"}).json()
    assert any(h["path"] == "app/services/inventory.py" for h in hits)
    assert client.get(f"/api/snapshots/{sid}/search", params={"q": '" OR 1=1 --'}).status_code == 200

    ev_id = routes[0]["evidence_id"]
    ev = client.get(f"/api/evidence/{ev_id}").json()
    assert ev["verified_now"] is True and ev["excerpt"] and ev["commit_sha"] == snap["commit_sha"]
    assert client.get("/api/evidence/ev_nope").status_code == 404
    v = client.post(f"/api/snapshots/{sid}/verify-location", json={"path": "app/main.py", "start_line": 1, "end_line": 9999}).json()
    assert v == {"ok": False, "reason": "invalid_line_range"}

    reports = client.get(f"/api/snapshots/{sid}/reports").json()
    rep = client.get(f"/api/reports/{reports[0]['id']}").json()
    assert rep["content"]["kind"] == "deterministic" and rep["content"]["evidence"]
    md = client.get(f"/api/reports/{reports[0]['id']}/markdown")
    assert md.status_code == 200 and md.headers["content-type"].startswith("text/markdown")


def test_agent_endpoints_when_disabled(client) -> None:
    st = client.get("/api/agent/status").json()
    assert st["available"] is False and st["agent_ready"] is False
    assert "disabled" in st["error"]
    assert st["selected_model"] == "openai/gpt-5.6-terra"
    assert client.get("/api/agent/models").status_code == 503
    job = ingest(client)
    r = client.post(f"/api/snapshots/{job['snapshot_id']}/agent-report")
    assert r.status_code == 503
    assert client.put("/api/agent/model", json={"model": "bad"}).status_code == 422
