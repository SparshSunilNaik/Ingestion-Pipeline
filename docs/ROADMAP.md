# Roadmap

Status labels: **done** (implemented and tested), **partial** (implemented with documented gaps),
**not done** (not implemented).

## M0–M2 (done)

Foundation, secure ingestion, static intelligence, evidence contract, deterministic and agent
reports, initial workspace. See git history up to `3734c9e`.

## M3 — Intelligence workbench

| Item | Status | Notes |
|---|---|---|
| Dark-first design system, app shell, collapsible sidebar, top bar, light theme | done | `app/globals.css`, `components/shell` |
| Dashboard with real metrics only | done | counts from the API; no fabricated trends |
| Workspace: Overview, Code, Architecture, Investigate, Report, Compare | done | URL-state deep links |
| Command palette, keyboard shortcuts, persisted resizable panels | done | Ctrl+K, Alt+1..6, `?` help |
| Loading / empty / error states | done | shared `components/ui.tsx` |
| Browser e2e tests (Playwright) | done | 15 tests, run in CI on Linux |
| Component unit tests (Vitest) | not done | e2e covers behaviour; no isolated component tests |
| Accessibility audit (axe) | not done | keyboard navigation and focus rings checked manually only |

## M4 — Deep analysis

| Item | Status | Notes |
|---|---|---|
| Re-exports (`__init__`, `export {}`, `export *`) | done | recursion depth < 4 |
| Inheritance, method lookup through hierarchies, `super()`, static/class methods | done | |
| Override-aware dynamic dispatch marked ambiguous | done | `possible_override` edges |
| Local type tracking (constructor assignment, annotations, Java/Go declarations) | partial | return types of calls, generics and Java field initializers are not inferred |
| Bounded execution-flow tracing | done | depth/step caps, certainty per step |
| Usage and change impact ("potentially affected") | done | static reachability only |
| Hybrid retrieval (FTS5 + symbols + graph + paths) | done | no embeddings by design |
| Multi-turn Q&A with validated citations | done | grounding status per answer |
| Benchmark with ground truth (+ optional live mode) | done | [BENCHMARKS.md](BENCHMARKS.md) |

## M5 — Release hardening

| Item | Status | Notes |
|---|---|---|
| Go and Java analyzers; go.mod / Maven / Gradle manifests | done | Gradle parsed by regex (declarative subset) |
| Incremental refresh, validated identical to a full rebuild | done | per-file IR cache; resolution always global |
| Snapshot comparison | done | files, symbols, dependencies, routes, edges, potential impact |
| Separate worker process (claiming, crash recovery, cancel, timeouts, retries, shutdown) | done | default `subprocess` mode with watchdog |
| Local API authentication (token, sessions, CSRF, rate limit, size limit, trusted hosts) | done | single-user model |
| Process isolation via Windows Job Objects | partial | resource limits + kill-on-close; **not a sandbox** |
| AppContainer / restricted token / egress filtering | not done | investigated only |
| Token / cost accounting for model calls | not done | the generate endpoint does not report usage |
| Multi-user authorisation, remote deployment | not done | out of scope for local-first |
| Scheduled refreshes, bare-mirror fetch | not done | refresh is on demand and re-clones shallowly |

## Suggested next steps

1. Call-return type inference (Go `x := pkg.New()`, Python factory functions) and Java field initializers.
2. Vitest component tests and an axe accessibility pass.
3. Usage accounting once OpenCode exposes it for stateless generation.
4. Investigate AppContainer launch for git/OpenCode without admin setup.
