# Semantic evaluation of repository explanations

Citation validity proves that an answer points at real, re-verified source lines. It does **not** prove that
the explanation is correct. This evaluation measures correctness separately, in three layers that are never
merged into one number.

| Layer | Who decides | What it measures |
|---|---|---|
| Deterministic checks | `app/evaluation/semantic.py` | expected facts mentioned (keyword groups), required evidence files cited, plausible-but-wrong statements asserted (negated mentions ignored), unsupported claims, uncertainty on unanswerable questions. Produces a *triage* label: `pass`, `needs_review`, `fail`. |
| Citation validity | Q&A pipeline | every cited evidence ID exists in the snapshot and re-verifies against disk |
| **Semantic accuracy** | **a human reviewer** | `correct` / `partially_correct` / `incorrect` per answer, recorded in a reviews file. Only this may be reported as accuracy. |

## Dataset

`tests/fixtures/semantic_eval.json` (version 1): 7 questions written by hand from the fixture source, covering
five architectures — a layered Python service, override-aware dispatch, a Flask app with a factory and an
abstract repository, a Go net/http program, a Spring controller with constructor injection — plus two
questions the code cannot answer (a production database that does not exist; authentication that is absent).
Each item has expected facts, required evidence, plausible-but-wrong claims, and a correct and a
plausible-wrong reference answer.

## Running

```powershell
cd backend
uv run python -m app.evaluation.semantic --mode reference                 # scorer self-test (no model; runs in CI)
uv run python -m app.evaluation.semantic --mode live --out run.json       # real Q&A through OpenCode (configured model)
uv run python -m app.evaluation.semantic --summarize run.json --reviews run.reviews.json
```

A live run writes `run.json` (answers, claims, scores, model, analyzer version, commit SHAs, configuration),
`run.review.md` (a sheet for the reviewer) and `run.reviews.json` (verdicts to fill in). CI never calls a model.

## Results

**Scorer self-test (reference mode):** all 7 correct reference answers pass and all 7 plausible-wrong ones fail.

**Live run 2026-11-19** — `docs/evaluation/semantic-live-2026-11-19.json`

| | |
|---|---|
| Model | `openai/gpt-5.6-terra` via OpenCode 2.0.29 (tool-less generate) |
| Analyzer | 0.3.0; fixture commits recorded in the run file |
| Configuration | ≤ 3 rounds per question, ≤ 20 read-only evidence requests |
| Automatic triage | 7 pass, 0 needs review, 0 fail |
| Mean expected-fact coverage | 0.91 |
| Plausible-but-wrong claims asserted | 0 |
| Unanswerable questions handled with uncertainty | 2/2 (one `insufficient_evidence`, one explicit "no authentication") |
| Citation validity | 25/25 claims cite valid evidence |
| **Human-reviewed semantic accuracy** | **not yet reviewed (0/7)** |

Observed limits of the keyword checks in this run: the Go answer says "creates a server bound to :8080" without
naming `server.New`, so that fact was counted as missing although the statement is accurate; one login answer
cited `auth.py` and `app.py` but not `tokens.py`. These are reasons the automatic label is triage, not a score.

To complete the evaluation, read `semantic-live-2026-11-19.review.md`, fill in
`semantic-live-2026-11-19.reviews.json`, and run `--summarize … --reviews …`.
