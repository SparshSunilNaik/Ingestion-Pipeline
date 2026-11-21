# Testing

```powershell
.\scripts\test.ps1               # ruff, ruff format, mypy, pytest, eslint, tsc, next build
.\scripts\test.ps1 -BackendOnly
.\scripts\test.ps1 -Live         # also real GitHub + real OpenCode (may incur model cost)
```

## Suites (`backend/tests`)

| Suite | Count | Covers |
|---|---|---|
| `unit/` | 105 | URL normalisation/rejection (37 cases), classification & language detection & unsafe paths (38), Python/TS analyzers, resolver, manifests, doc sections, job transitions/atomic claiming/lease recovery/cancel, OpenCode adapter with `httpx.MockTransport` (sanitisation, no model substitution, error normalisation, endpoint allow-list, cancellation, deny-all sessions) |
| `security/` | 11 | git env hardening, malicious inherited config + hook (with a positive control), protocol allow-list, timeout kill, symlink handling, path escapes, malicious tracked paths, fabricated evidence, gateway scope/budget, log redaction, repository scripts never executed |
| `integration/` | 22 | full ingestion of a synthetic repo via local `file://` remote (exact SHA, inventory equals `git ls-files`, every evidence record re-verifies, graph edges), cache reuse, new commit, failed refresh preserves snapshot, analysis-failure cleanup, partial coverage, storage budget, interrupted-job recovery via worker, API end-to-end, agent workflow with scripted model (tool requests, traversal/symlink refusal, prompt injection, format retry, budget exhaustion), agent job through mocked OpenCode HTTP |
| `live/` | 2 | opt-in (`IP_LIVE_TESTS=1`): real GitHub ingestion, real OpenCode generate |

Offline tests use `tests/fixtures/sample_repo` (FastAPI backend, Next.js/TS frontend,
README with an embedded prompt-injection comment, manifests, Dockerfile, CI file, a
binary, and a symlink added at test time). CI never needs network access to GitHub or a
model provider.

## Latest local results (2026-11-18, Windows 11, Python 3.14.7)

- `pytest`: 137 passed, 3 skipped (2 live tests skipped by default; 1 symlink-creation test
  skipped because the host lacks the symlink privilege). With `IP_LIVE_TESTS=1` the 2 live
  tests passed.
- ruff, ruff format, mypy: clean. Frontend: eslint, `tsc --noEmit`, `next build`: clean.
- `pip-audit`: no known vulnerabilities; `npm audit --omit=dev`: 0.

## Recorded end-to-end acceptance run

- Repository: `https://github.com/pallets/itsdangerous`
- Commit: `672971d66a2ef9f85151e53283113f33d642dabd` (matched `git ls-remote … HEAD`)
- Inventory: 50 tracked files, 44 analysed, 1 excluded (lockfile), not partial;
  languages python (15 files) and shell (1)
- Evidence: 530 records, 0 rejected
- Graph: 208 nodes, 335 edges (277 resolved, 35 external, 23 unresolved)
- Deterministic report generated; agent report with `openai/gpt-5.6-terra` generated
  (20 claims, 71/71 citations verified, 0 unsupported)
- UI verified in a browser: dashboard, workspace tabs, graph inspection and impact
  analysis, and evidence links opening the exact highlighted source range

## M3–M5 test suite

| Suite | Count | Adds |
|---|---|---|
| `unit/` | 109 | Go/Java analyzers, go.mod/pom/Gradle parsing (no entity expansion) |
| `security/` | 19 | auth on protected endpoints, session cookie flags, CSRF, login rate limit, request-size limit, trusted hosts, token-file ACL, Job Object membership/memory/process limits/kill-on-close |
| `integration/` | 41 | benchmark thresholds, flows, usage/impact, retrieval, incremental == full rebuild, analyzer upgrade preserves the old snapshot, multi-turn Q&A, foreign-evidence rejection, worker process (exclusive claiming across two workers, timeout, crash, cancel, shutdown requeue), migration 0001→0002 with data, API v2 |
| `live/` | 2 | opt-in, unchanged |
| `frontend/e2e` (Playwright) | 15 | login (wrong token rejected), sidebar collapse persistence and command palette, dashboard from real data, URL validation and failed-job state, Overview citations opening exact source lines, Code explorer (tree filter, outline, references), Architecture graph/inspector/focus/execution flow, Report (TOC, exports), Compare of two analysed commits, agent-unavailable state, model selection with a mocked agent API, unknown-snapshot error, no horizontal overflow at 1920/1366/1024 px |

Run the e2e suite locally with Edge (no browser download needed):

```powershell
cd frontend
$env:PW_CHANNEL="msedge"; npx playwright test
```

The harness starts an isolated backend (port 8765, `IP_ENVIRONMENT=test`, its own data directory,
a fixed test-only token) and a production build of the frontend (port 3100).

## M6 test suite

| Suite | Count | Covers |
|---|---|---|
| backend `unit/` | 115 | adds the semantic-evaluation scorer (reference answers, negation, uncertainty, separation of human review) |
| backend `security/` | 19 (1 skipped without symlink privilege) | unchanged |
| backend `integration/` | 42 | adds the held-out fixture thresholds, return-type/attribute-type resolution via the benchmark, dotted-name retrieval |
| backend `live/` | 2 (opt-in) | unchanged |
| frontend Vitest (`frontend/test`) | 40 | explorer, source viewer, citation navigation, assistant, architecture interactions, loading/error states, authentication, snapshot comparison, deep links; axe on rendered components |
| frontend Playwright (`frontend/e2e`) | 20 | the full workspace against a real seeded backend; axe (WCAG A/AA incl. colour contrast) on home, progress, overview, file and assistant views; keyboard (/, Ctrl+F, Ctrl+I, Delete on tabs); reduced motion; no horizontal overflow at 1920/1366/1024 |

```powershell
cd frontend
npm test                                   # Vitest
$env:PW_CHANNEL="msedge"; npx playwright test
```

Accessibility fixes made because of these checks: muted-text contrast raised in both themes; citation and
search buttons' accessible names now contain their visible text; tab strips contain only tabs.

## M7 additions

- Regression for the owner-visible "500 Internal Server Error": `frontend/test/proxy.test.ts` drives the new
  `/api` proxy against real sockets (refused connection → 503 `backend_unavailable`, silent backend → 504,
  status/body/query/all `Set-Cookie` pass through, header allow-list, path traversal) and
  `frontend/test/backend-status.test.tsx` covers the recovery screen (auto re-check, start command, no raw 500).
- `backend/tests/integration/test_start_scripts.py` (Windows): `start-backend.ps1` with captured output serves
  `/api/health` from an isolated data directory.
- Assistant context: pack, prompt and API validation tests (`test_qa_selected_context_leads_the_pack`,
  `test_qa_prompt_names_the_attached_context`, `test_question_context_must_belong_to_the_snapshot`).
- Browser: graph → source → graph keeps the exact camera transform and the selection.
- The Playwright frontend now runs on port 3210 (`PW_FRONTEND_PORT`), backend 8765 (`PW_BACKEND_PORT`).

