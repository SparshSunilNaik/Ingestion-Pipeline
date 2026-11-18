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
| Browser e2e tests (Playwright) | done | superseded by the M6 suite (20 tests) |
| Component unit tests (Vitest) | done in M6 | 40 tests |
| Accessibility audit (axe) | done in M6 | jsdom (structure) and browser (incl. colour contrast) |

## M4 — Deep analysis

| Item | Status | Notes |
|---|---|---|
| Re-exports (`__init__`, `export {}`, `export *`) | done | recursion depth < 4 |
| Inheritance, method lookup through hierarchies, `super()`, static/class methods | done | |
| Override-aware dynamic dispatch marked ambiguous | done | `possible_override` edges |
| Local type tracking (constructor assignment, annotations, Java/Go declarations) | done in M6 (bounded) | call return types (one hop), Java field initializers and Python attribute types added; generics and chained calls are not inferred |
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

## M6 — Complete product, UX rebuild, user acceptance

| Item | Status | Notes |
|---|---|---|
| Workspace rebuilt around explorer, tabbed canvas and persistent assistant | done | replaces six sibling views; deep links and older `?view=` links work |
| First-run home, resume ("continue where you left off"), recent investigations | done | |
| Analysis progress from real stages (symbols / relationships / architecture reported by the analyzer) | done | no percentage bar; cancel, retry, failure explanations; cached commits shown as skipped |
| Source viewer: highlighting, find in file, outline, callers/callees, contextual actions | done | |
| Symbol deep dive: usage, dependencies, change impact with dependents graph | done | |
| Architecture: smart default view, directory drill-down, scoping, filters, focus, inspector | done | very large graphs are panned at a legible zoom rather than fitted |
| Execution flows as their own contexts (steps and graph) | done | |
| Assistant: contextual questions, explicit model, history, cancel, retry, uncertainty, snapshot isolation | done | |
| Go call-return type inference; Java field initializers; Python attribute types | done | bounded one-hop; see BENCHMARKS.md |
| Held-out evaluation fixture | done | first-run result recorded before any fix |
| Semantic evaluation framework | done | reference self-test in CI; live run recorded; **human review pending** |
| Vitest component tests + axe | done | 40 tests |
| Playwright rewritten for the new UI + axe incl. contrast | done | 20 tests |
| Retrieval: exact dotted names rank first | done | found during acceptance |
| Additional OS isolation without admin (low integrity level / AppContainer) | investigated, not implemented | see SECURITY.md |
| Snapshot comparison exercised on a real GitHub repository | partial | verified on real git fixtures (two commits) and in the UI; itsdangerous HEAD did not change during acceptance |
| AI technical report regenerated in the new UI | not re-verified live in M6 | unchanged backend path, verified in M2/M5 |

## Suggested next steps

1. Human review of the live semantic-evaluation answers (`docs/evaluation/*.review.md`), then grow the dataset.
2. Run git under a low-integrity token with a low-integrity staging directory (no admin needed; see SECURITY.md).
3. Generics and chained-call type inference; more held-out fixtures (Kotlin/Rust are inventoried only).
4. Usage accounting once OpenCode exposes it for stateless generation.
