# Windows setup

Tested on Windows 11 with Python 3.14.7, Node.js 26.9, npm 11.19, Git 2.55, uv 0.13.9 and
OpenCode 2.0.29. Minimums: Python 3.12, Node.js 20.9, Git 2.30. No WSL, Docker or GPU needed.

## Steps

```powershell
git clone https://github.com/SparshSunilNaik/Ingestion-Pipeline.git
cd Ingestion-Pipeline
.\scripts\setup.ps1
```

`setup.ps1` checks tools, installs `uv` per-user with `pip install --user uv` if missing,
runs `uv sync` in `backend/` and `npm ci` in `frontend/`, and copies
`backend/.env.example` to `backend/.env` when absent.

Start in two terminals:

```powershell
.\scripts\start-backend.ps1    # http://127.0.0.1:8000  (OpenAPI UI: /docs)
.\scripts\start-frontend.ps1   # http://localhost:3000
```

Check everything: `.\scripts\health.ps1`. Run checks: `.\scripts\test.ps1`
(`-BackendOnly`, `-Live`).

If script execution is disabled, run once in that terminal:
`Set-ExecutionPolicy -Scope Process Bypass`.

## Smart App Control / Application Control

On the development machine, Windows Application Control blocked:
- launcher `.exe` shims created inside the venv (`alembic.exe`, `pytest.exe`, …), and
- some unsigned compiled extensions (SQLAlchemy's Cython modules, mypy's mypyc build).

Mitigations already in the repository:
- every tool is invoked as `uv run python -m <tool>` (scripts and docs);
- `backend/pyproject.toml` builds `sqlalchemy` (with `DISABLE_SQLALCHEMY_CEXT=1`) and `mypy`
  from source, which yields their official pure-Python implementations on every OS.

If another package is blocked, add it to `[tool.uv] no-binary-package` only if it has a
pure-Python fallback.

`uv` may warn about hardlinks across drives; the scripts set `UV_LINK_MODE=copy`.

## OpenCode

Install and authenticate OpenCode separately (`opencode auth`). The backend starts its
own private server on port 47900 by default; change with `IP_OPENCODE_PORT`, or set
`IP_OPENCODE_MODE=disabled` to run without agent features.

## Data locations

`backend/data/` (git-ignored): `ingestion.db` (SQLite WAL), `snapshots/`, `staging/`,
`git-sandbox/` (empty git config/hooks/template), `opencode-sandbox/`.

## M5 notes

- **API token**: created on first backend start at `backend\data\api-token` with a user-only ACL. Paste it
  into the login page once. `scripts\health.ps1` reads it locally to call protected endpoints and never
  prints it. Set `IP_API_TOKEN` to choose your own.
- **Worker** (`IP_WORKER_MODE`): `subprocess` (default; the API starts and supervises
  `python -m app.worker_main`), `external` (run `scripts\start-worker.ps1` yourself), `inprocess` (thread,
  tests), `none`.
- **Playwright**: `$env:PW_CHANNEL="msedge"; npx playwright test` uses the installed Edge. If `uv` is not on
  `PATH`, also set `$env:IP_UV_CMD="python -m uv"`.
- No WSL, Docker or administrator rights are required; Job Objects are created per user without elevation.
