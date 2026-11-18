# Ingestion-Pipeline

Evidence-grounded repository intelligence. Paste a public GitHub repository URL; the
system acquires it safely, analyses its source statically, builds a graph of files,
symbols, imports, calls and routes, and produces a report in which **every statement
cites verifiable evidence** (file + exact line range at an exact commit). An optional
AI agent (through [OpenCode](https://opencode.ai)) writes a narrative on top of that
evidence; its claims are validated and downgraded when unsupported.

> Status: first functional release (milestones M0–M2 plus an initial agent workflow).
> Not production-ready. See [Known limitations](#known-limitations) and
> [docs/ROADMAP.md](docs/ROADMAP.md).

## What works today

| Area | Implemented |
|---|---|
| Ingestion | Strict GitHub URL validation; hardened shallow `git clone` (no hooks, no credential prompts, no LFS smudge, no submodules, protocol allow-list, timeouts); exact commit SHA; atomic snapshot promotion; per-commit cache; failed refreshes never touch the last valid snapshot |
| Inventory | Classification (source/test/docs/config/manifest/CI/container/binary/generated/vendored/symlink/submodule/unsafe path), language detection, configurable limits, explicit partial-coverage reporting |
| Static analysis | Python (stdlib `ast`), TypeScript/JavaScript (Tree-sitter): functions, classes, methods, interfaces, imports/exports, calls, inheritance; routes for FastAPI, Flask, Django, Express, Next.js; entry points; manifests (`package.json`, `pyproject.toml`, `requirements*.txt`) |
| Graph | NetworkX graph persisted in SQLite; every edge has a type, resolution status (`resolved`/`ambiguous`/`external`/`unresolved`) and evidence; impact ("what depends on this?") analysis |
| Evidence | Versioned contract, stable IDs, verifier that rejects fabricated paths/line ranges and stale excerpts |
| Reports | Deterministic report (overview, installation/usage, architecture, code structure, engineering assessment, evidence table) as JSON and Markdown; agent narrative with validated citations |
| Agent | OpenCode v2 adapter (stateless, tool-less generation); backend-enforced read-only evidence gateway; bounded investigation loop; structured output validated with Pydantic |
| Frontend | Dashboard, repository submission, job progress, workspace (overview, files, architecture graph + Mermaid diagram, report, evidence source viewer), agent settings |
| Ops | PowerShell scripts for setup/start/test/health; GitHub Actions CI (Linux + Windows) |

## Quick start (Windows 11, PowerShell)

Prerequisites: Python 3.12+, Node.js 20.9+, Git. OpenCode is optional (agent reports only).

```powershell
.\scripts\setup.ps1           # installs uv if needed, syncs backend, npm ci
.\scripts\start-backend.ps1   # API + worker on http://127.0.0.1:8000 (OpenAPI at /docs)
.\scripts\start-frontend.ps1  # UI on http://localhost:3000
.\scripts\health.ps1          # checks backend, worker, OpenCode, frontend
.\scripts\test.ps1            # lint, type checks, tests, frontend build
```

See [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md) for details, including the Smart App
Control workaround this repository already applies.

## Repository layout

```
backend/   FastAPI app (app/: api, core, database, ingestion, analysis, graph,
           evidence, search, agents, reports, schemas), Alembic, tests
frontend/  Next.js 16 App Router + TypeScript + Tailwind + React Flow + Mermaid
docs/      Architecture decisions, security, evidence contract, OpenCode, testing
scripts/   PowerShell helpers
tests/fixtures/sample_repo/  Synthetic repository used by the offline test-suite
```

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — components and data flow
- [docs/SECURITY.md](docs/SECURITY.md) — threat model, controls, residual risks
- [docs/EVIDENCE_CONTRACT.md](docs/EVIDENCE_CONTRACT.md) — evidence and claim semantics
- [docs/OPENCODE_INTEGRATION.md](docs/OPENCODE_INTEGRATION.md) — runtime, model, API surface
- [docs/TESTING.md](docs/TESTING.md) — test strategy and recorded acceptance run
- [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md) — environment setup
- [docs/DECISIONS.md](docs/DECISIONS.md) — decision log
- [docs/ROADMAP.md](docs/ROADMAP.md) — milestones and what is not built yet

## Known limitations

- Only Python, TypeScript and JavaScript are parsed; other languages are inventoried only.
- Call resolution is name-based (same file, imports, `self`/`this` methods). Dynamic
  dispatch, inheritance-based method lookup, decorators' runtime effects and reflection
  are not modelled; such call sites are counted, not guessed.
- "Declared but not observed" dependencies are **not** claimed to be unused.
- Agent narratives cite verified locations, but the semantic accuracy of a sentence is
  not machine-verified; only its evidence is.
- Single-process worker; SQLite. Designed for one machine.
