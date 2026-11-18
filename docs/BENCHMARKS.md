# Repository-intelligence benchmark

`backend/app/bench.py` ingests a fixture repository through the real pipeline (git clone from a local
remote, inventory, analysis, evidence, report) and scores the result against **hand-written ground truth**.

| Fixture | Purpose | Ground truth |
|---|---|---|
| `tests/fixtures/bench_repo` | **Development** fixture. Analyzer changes are made and checked against it. | `tests/fixtures/bench_expected.json` |
| `tests/fixtures/eval_repo` | **Held-out** fixture with different architectures (Flask + abstract repository, Go net/http with constructor function, Spring constructor injection + field initializer, Express). Written from source before the analyzer was run on it. It must not be tuned against: a gap found here is reproduced and fixed in the development fixture. | `tests/fixtures/eval_expected.json` |

```powershell
cd backend
uv run python -m app.bench                    # development fixture
uv run python -m app.bench --fixture eval     # held-out fixture
uv run python -m app.bench --live             # + 2 bounded Q&A questions through OpenCode
```

Both fixtures have thresholds enforced in CI (`tests/integration/test_intelligence.py`); the held-out thresholds are looser.

## Results (2026-11-19, analyzer 0.3.0, Windows 11, Python 3.14)

| Metric | Development fixture | Held-out fixture |
|---|---|---|
| Symbol extraction precision / recall | 1.000 / 1.000 (38/38) | 1.000 / 1.000 (35/35) |
| Relationship precision / recall | 1.000 / 1.000 (33/33) | 1.000 / 1.000 (24/24) |
| Ambiguous dynamic dispatch flagged | yes | yes |
| Dynamic call not over-resolved | yes | yes |
| Evidence citation validity | 104/104 | 91/91 |
| Route recall | 4/4 (FastAPI, Gin, Spring) | 5/5 (Flask ×2, net/http, Spring, Express) |
| Flow tracing: must-reach recall | 6/6 from `POST /login` | 5/5 from `GET /items/<sku>` |
| Retrieval hit@3 / MRR | 1.0 / 0.833 (6 queries) | 1.0 / 0.900 (5 queries) |
| Analysis runtime / peak Python memory | 0.70 s / 4.3 MB | 0.68 s / 4.3 MB |

**Held-out first run (before any change prompted by it): relationship recall 0.958 (23/24), precision 1.0.**
The miss was a TypeScript module-level `const catalog = new Catalog()` used inside a route callback. An
analogous but different case was added to the development fixture (`web/src/main.ts`: `shared`/`quick`) and
fixed there; the held-out fixture then scored 24/24 without being edited.

### What changed between analyzer 0.2.0 and 0.3.0

| Gap (0.2.0) | Fix (0.3.0) |
|---|---|
| Go: `s := store.Open(); s.Add()` — return types of calls not inferred | Declared result types are recorded (`T`, `*T`, `pkg.T`, first of `(T, error)`); one bounded hop resolves the variable's type |
| Java: field initializers not walked (`private final Clock clock = new Clock();`) | Initializers are walked and attributed to the class |
| Python: `self.repo.fetch()` where `self.repo = repo` (annotated parameter) unresolved | Attribute types from constructor assignments, annotated parameters and annotated attributes, looked up through base classes; overrides make the call ambiguous with each candidate |
| Python: `x = factory(); x.m()` only typed for capitalised constructors | Any call; typed only when the callee is a statically resolved function with a return annotation |
| TS: module-level `const x = new C()` not used for typing | Recorded as a module instantiation |

Development fixture relationship recall went from 0.935 (29/31) under 0.2.0 to 1.0 (33/33, two cases added).

## Real-repository regression (pallets/itsdangerous @ 672971d6…)

| | 0.1.0 | 0.2.0 | 0.3.0 |
|---|---|---|---|
| Evidence records (all re-verified) | 530 | 573 | 574 (0 rejected) |
| Graph nodes / edges | 208 / 335 | 211 / 385 | 211 / 389 |
| Resolved call sites | 90 | 121 | 121 |
| Call sites left unresolved as dynamic receivers | 153 | 120 | 119 |
| Ambiguous edges (override-aware dispatch) | 0 | 20 | 24 |

The additional ambiguous edges in 0.3.0 come from `self.algorithm.get_signature(...)`, now typed through the
attribute's declared type and fanned out to every `SigningAlgorithm` override. Each analyzer version creates a
new snapshot of the same commit; earlier analyses are preserved.

"Claim support" and "evidence validity" mean a cited ID exists and re-verifies against the source on disk.
They do **not** measure whether an explanation is correct — see [EVALUATION.md](EVALUATION.md).
