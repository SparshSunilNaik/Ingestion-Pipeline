# Roadmap

## Done in this release

- **M0 Foundation** — FastAPI, settings, logging, errors, SQLite/Alembic, typed API,
  OpenAPI, Next.js shell, PowerShell scripts, CI.
- **M1 Secure ingestion** — URL validation, hardened git, limits, atomic snapshots, cache,
  inventory and coverage.
- **M2 Static intelligence** — Python/TS/JS analyzers, framework and route discovery,
  dependency analysis, graph with resolution status, evidence contract and verifier,
  deterministic reports, initial agent workflow, frontend workspace.

## Not done yet (explicitly incomplete)

- Inheritance-aware method resolution, type inference, cross-package call graphs.
- Languages beyond Python/TypeScript/JavaScript (Go, Java, Rust… are inventoried only).
- Execution-flow narratives beyond route → handler → direct callees.
- Report diffing between snapshots; scheduled refreshes.
- Authentication/authorisation for the API (localhost-only today).
- OS-level sandboxing of the OpenCode process and of git.
- Token/cost accounting for agent runs (not exposed by the generate endpoint).
- Frontend tests (only lint/type-check/build run in CI).

## Recommended M3 plan

1. **Deeper resolution**: class hierarchy index (MRO for Python, `extends`/`implements`
   for TS) to resolve `self.method()` through bases; simple type hints/assignment tracking
   for `obj = Cls(); obj.m()`; resolve re-exports (`__init__` and `index.ts` barrels).
2. **Execution flows**: bounded path search from entry points/routes through resolved
   calls, rendered as sequence diagrams with per-hop evidence.
3. **Agent investigation quality**: per-section focused prompts, retrieval ranking with
   FTS + graph centrality, evidence-request usage targets, regression set of repositories
   with expected facts to measure precision/recall of claims.
4. **Language plug-ins**: Go and Java analyzers implementing `LanguageAnalyzer`.
5. **Incremental refresh**: keep bare mirrors, fetch, diff trees, re-analyse changed files.
6. **Isolation**: run git and the OpenCode server under a restricted Windows job object /
   AppContainer (or a container on Linux); restrict egress to required hosts.
7. **Ops**: separate worker process, API auth token, structured audit log of agent
   requests, frontend component tests (Vitest + Testing Library) and Playwright smoke test.
