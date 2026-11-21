import json

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient

from app.core.config import BACKEND_ROOT
from app.database.migrate import upgrade_database
from app.ingestion.pipeline import IngestionPipeline
from app.ingestion.worker import Worker
from app.main import create_app
from tests.conftest import FIXTURES, git, make_git_repo


def test_upgrade_from_0001_preserves_data(tmp_path) -> None:
    url = f"sqlite:///{(tmp_path / 'old.db').as_posix()}"
    cfg = Config(str(BACKEND_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    cfg.attributes["configure_logger"] = False
    command.upgrade(cfg, "0001")
    eng = sa.create_engine(url)
    with eng.begin() as c:
        c.execute(
            sa.text(
                "INSERT INTO repositories (id, owner, name, canonical_url, created_at, updated_at) VALUES (1,'a','b','https://github.com/a/b','2026-01-01','2026-01-01')"
            )
        )
        c.execute(
            sa.text(
                "INSERT INTO snapshots (id, repository_id, commit_sha, storage_path, status, analyzer_version, acquired_at, commit_info, recent_commits, coverage, inventory_summary, analysis_summary) "
                "VALUES (1, 1, 'abc', 'x', 'ready', '0.1.0', '2026-01-01', '{}', '[]', '{}', '{}', '{}')"
            )
        )
    eng.dispose()
    upgrade_database(url)
    eng = sa.create_engine(url)
    with eng.begin() as c:
        assert c.execute(sa.text("SELECT version_num FROM alembic_version")).scalar() == "0002"
        assert c.execute(sa.text("SELECT analyzer_version FROM snapshots WHERE id = 1")).scalar() == "0.1.0"
        # same commit, new analyzer version is now allowed alongside the old analysis
        c.execute(
            sa.text(
                "INSERT INTO snapshots (repository_id, commit_sha, storage_path, status, analyzer_version, acquired_at, commit_info, recent_commits, coverage, inventory_summary, analysis_summary) "
                "VALUES (1, 'abc', 'x', 'ready', '0.2.0', '2026-01-02', '{}', '[]', '{}', '{}', '{}')"
            )
        )
        with pytest.raises(sa.exc.IntegrityError):
            c.execute(
                sa.text(
                    "INSERT INTO snapshots (repository_id, commit_sha, storage_path, status, analyzer_version, acquired_at, commit_info, recent_commits, coverage, inventory_summary, analysis_summary) "
                    "VALUES (1, 'abc', 'x', 'ready', '0.2.0', '2026-01-03', '{}', '[]', '{}', '{}', '{}')"
                )
            )
        tables = {r[0] for r in c.execute(sa.text("SELECT name FROM sqlite_master WHERE type='table'"))}
        assert {"file_analyses", "conversations", "messages", "api_sessions"} <= tables
    eng.dispose()


@pytest.fixture
def client(settings, remotes, tmp_path):
    remote = make_git_repo(tmp_path / "bench", FIXTURES / "bench_repo")
    remotes.add("acme/bench", remote)
    pipeline = IngestionPipeline(settings, clone_url_resolver=remotes)
    app = create_app(settings, pipeline=pipeline)
    with TestClient(app, headers={"Authorization": f"Bearer {app.state.auth.token}"}) as c:
        c.worker = Worker(settings, app.state.runtime, pipeline)
        c.remote = remote
        yield c


def ingest(c) -> dict:
    r = c.post("/api/jobs", json={"url": "https://github.com/acme/bench"})
    jid = r.json()["job"]["id"]
    c.worker.run_once()
    job = c.get(f"/api/jobs/{jid}").json()
    assert job["status"] == "succeeded", job
    return job


def test_v2_endpoints(client) -> None:
    c = client
    sid = ingest(c)["snapshot_id"]
    tree = c.get(f"/api/snapshots/{sid}/tree").json()["files"]
    assert any(f["p"] == "svc/core/auth.py" and f["a"] for f in tree)
    u = c.get(f"/api/snapshots/{sid}/usage", params={"key": "sym:svc/core/auth.py#login"}).json()
    assert u["related_routes"][0]["label"] == "POST /login"
    eps = c.get(f"/api/snapshots/{sid}/flows/entry-points").json()
    login = next(e for e in eps if e["label"] == "POST /login")
    fl = c.get(f"/api/snapshots/{sid}/flows/trace", params={"key": login["start_key"]}).json()
    assert any(s["to"]["label"] == "sign" for s in fl["steps"])
    assert c.get(f"/api/snapshots/{sid}/flows/trace", params={"key": "sym:nope"}).status_code == 404
    rr = c.get(f"/api/snapshots/{sid}/retrieve", params={"q": "issue_token"}).json()
    assert rr["results"][0]["key"] == "sym:svc/core/tokens.py#issue_token"
    for view in ("modules", "files", "calls", "routes"):
        g = c.get(f"/api/snapshots/{sid}/graph/view", params={"view": view}).json()
        keys = {n["key"] for n in g["nodes"]}
        assert g["nodes"] and all(e["source"] in keys and e["target"] in keys for e in g["edges"]), view
    focus = c.get(f"/api/snapshots/{sid}/graph/view", params={"view": "focus", "focus": "sym:svc/core/auth.py#login", "radius": 1}).json()
    assert any(n.get("focus") for n in focus["nodes"]) and len(focus["nodes"]) > 3
    im = c.get(f"/api/snapshots/{sid}/impact", params={"key": "sym:svc/core/models.py#Account.validate"}).json()
    assert im["dependents"] and im["related_tests"] == ["tests/test_auth.py"] and im["potentially_affected_routes"]
    # refresh + compare
    (c.remote / "svc" / "core" / "tokens.py").write_text("def issue_token(account) -> str:\n    return account.name\n", encoding="utf-8")
    git(c.remote, "add", "-A")
    git(c.remote, "commit", "-q", "-m", "drop sign")
    repo_id = c.get("/api/repositories").json()[0]["id"]
    r = c.post(f"/api/repositories/{repo_id}/refresh")
    assert r.status_code == 202
    c.worker.run_once()
    head = c.get(f"/api/jobs/{r.json()['job']['id']}").json()["snapshot_id"]
    cmp = c.get("/api/compare", params={"base": sid, "head": head}).json()
    assert {s["qualified_name"] for s in cmp["symbols"]["removed"]} == {"sign"}
    assert cmp["files"]["modified"][0]["path"] == "svc/core/tokens.py"
    assert any(e["target"] == "sym:svc/core/tokens.py#sign" for e in cmp["graph"]["edges_removed"])
    # Q&A endpoints: conversation is created; asking needs the agent runtime (disabled in tests)
    conv = c.post(f"/api/snapshots/{sid}/conversations", json={}).json()
    assert conv["model"] == "openai/gpt-5.6-terra" and conv["snapshot_id"] == sid
    assert c.post(f"/api/conversations/{conv['id']}/messages", json={"content": "where is login used?"}).status_code == 503
    assert c.get(f"/api/conversations/{conv['id']}").json()["messages"] == []
    assert json.dumps(c.get(f"/api/snapshots/{sid}/conversations").json())


def test_question_context_must_belong_to_the_snapshot(client) -> None:
    c = client
    sid = ingest(c)["snapshot_id"]
    c.app.state.runtime.cfg.mode = "external"  # asking only queues a job; no model is called here
    conv = c.post(f"/api/snapshots/{sid}/conversations", json={}).json()
    bad = c.post(f"/api/conversations/{conv['id']}/messages", json={"content": "explain this", "context_key": "sym:other/repo.py#secret"})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "validation_failed"
    ok = c.post(f"/api/conversations/{conv['id']}/messages", json={"content": "explain this", "context_key": "sym:svc/core/auth.py#login"})
    assert ok.status_code == 202
    msgs = c.get(f"/api/conversations/{conv['id']}").json()["messages"]
    assert msgs[0]["payload"]["context"] == {"key": "sym:svc/core/auth.py#login", "kind": "function", "label": "login", "path": "svc/core/auth.py"}
