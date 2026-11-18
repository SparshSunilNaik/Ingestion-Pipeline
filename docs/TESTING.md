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
