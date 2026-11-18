# Repository-intelligence benchmark

`backend/app/bench.py` ingests `tests/fixtures/bench_repo` through the real pipeline and scores
the results against **hand-written ground truth** in `tests/fixtures/bench_expected.json`.
The ground truth was written from the fixture source, not from analyzer output.

```powershell
cd backend
uv run python -m app.bench            # deterministic, no network, no model
uv run python -m app.bench --live     # + 2 bounded Q&A questions through OpenCode
```

The deterministic thresholds are also enforced in CI (`tests/integration/test_intelligence.py::test_benchmark_thresholds`).

## Fixture coverage

Python packages with `__init__` re-exports, relative imports, inheritance with an override, `self`/`super()`/`cls`
dispatch, static and class methods, FastAPI routes, a `__main__` guard, a dynamic call that must **not** be resolved;
TypeScript `export {}` and `export *` re-exports, default import, constructor + method call; Go module/package
imports, receiver methods, Gin route; Java package-private inheritance, field-typed calls, Spring route; manifests for
pip, npm, Go modules and Maven; a README that claims GraphQL and Redis (absent from code) and has no installation section.

## Results (2026-11-18, analyzer 0.2.0, Windows 11, Python 3.14)

| Metric | Pre-M4 analyzer (`3734c9e`) | Current |
|---|---|---|
| Symbol extraction precision / recall | 1.000 / 0.676 (no Go/Java) | **1.000 / 1.000** (37/37) |
| Relationship resolution precision / recall | 1.000 / 0.355 (11 found) | **1.000 / 0.935** (29/31) |
| Ambiguous dynamic dispatch flagged (`self.label()` with override) | no | **yes** |
| Dynamic call not over-resolved (`helper_factory().run()`) | yes | **yes** |
| Evidence citation validity | — | **99/99 (1.0)** |
| Route recall (FastAPI, Gin, Spring) | — | **4/4** |
| Dependency status (observed / not observed) | — | **4/4 correct** |
| Flow tracing: POST /login reaches expected functions | — | **6/6** |
| Retrieval hit@3 / MRR (6 queries) | — | **1.0 / 0.833** |
| Misleading README: claimed tech not reported as frameworks; README purpose labelled docs-only | — | **yes / yes** |
| Missing installation docs reported as unknown | — | **yes** |
| Coverage | — | 23/23 files, not partial |
| Analysis runtime / peak Python memory | — | 0.72 s / 4.3 MB (tracemalloc, Python allocations only) |
| Live Q&A claim support (`--live`, `openai/gpt-5.6-terra`) | — | **9/9 claims cite valid evidence** (2 questions, both "grounded") |

Relationship misses (honest, both known limitations):
1. `handle → Store.Add` in Go: `s := store.Open()` — the return type of a call is not inferred.
2. `UserController → new UserService()` in a Java field initializer: field initializers outside methods are not walked.

"Claim support" means every cited evidence ID exists in the snapshot and re-verifies against the source on disk.
It does **not** prove the sentence is a correct interpretation of the code.

## Real-repository regression (pallets/itsdangerous @ 672971d6…)

| | Analyzer 0.1.0 (snapshot 1) | Analyzer 0.2.0 (snapshot 2) |
|---|---|---|
| Evidence records (all re-verified) | 530 / 530 valid | 573 / 573 valid |
| Graph nodes / edges | 208 / 335 | 211 / 385 |
| Resolved call edges | 90 | 121 |
| Call sites left unresolved as dynamic receivers | 153 | 120 |
| Ambiguous (override-aware dispatch) | 0 | 20 edges |

Both snapshots exist side by side: re-analysing the same commit with a newer analyzer created a new
snapshot and left the previous analysis untouched.
