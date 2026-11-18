# OpenCode integration

## What was found on the development machine (2026-11-18)

- `opencode --version` → **v2.0.29**. The v2 CLI exposes `opencode serve` (HTTP API + web
  UI) and `opencode api` (CLI client). The API publishes an OpenAPI document at
  `/openapi.json` ("opencode HttpApi", experimental surface).
- Authentication: HTTP Basic, user `opencode`, password printed by `serve` or set with
  `OPENCODE_SERVER_PASSWORD` (verified). Bearer tokens are rejected.
- `opencode models` lists `openai/gpt-5.6-terra` (name "GPT-5.6 Terra"), plus `-fast` and
  `-flex` variants. **The model identifier used is `openai/gpt-5.6-terra`**, sent to the
  API as `{"providerID": "openai", "id": "gpt-5.6-terra"}`. A test generation returned
  the expected text.
- `GET /api/model` returns per-model `headers` that include a provider account ID; the
  adapter never forwards raw model objects.

## Integration design

`backend/app/agents/opencode_adapter.py` uses only these endpoints (enforced by an
allow-list checked before every request):

| Endpoint | Use |
|---|---|
| `GET /api/info` | availability, version |
| `GET /api/model` | discovery (sanitised) and exact-match resolution |
| `POST /api/experimental/generate` | **the only inference path** — one stateless generation |
| `POST /api/session` | session creation with deny-all permissions (lifecycle support; unused by the workflow) |
| `DELETE /api/session/{id}` | session deletion |
| `POST /api/session/{id}/interrupt` | interrupt an active session execution |

Why stateless generate instead of sessions: sessions run an agent loop with built-in
tools (shell, file read/write, web). Even with deny-all permission rules, a session is a
tool-capable agent operating in a directory. The generate endpoint has no tool loop:
asked to read a canary file and print it, the model replied `NO_TOOLS` and the canary
content never appeared. The backend therefore owns every repository read through
`ReadOnlyGateway`, which is the enforced boundary.

### Runtime modes (`IP_OPENCODE_MODE`)

- `managed` (default): the backend starts `opencode serve --hostname 127.0.0.1 --port 47900`
  from an empty sandbox directory (`backend/data/opencode-sandbox`) with a random password
  in memory, waits for `/api/info`, and stops it (process tree) on shutdown.
- `external`: connect to `IP_OPENCODE_BASE_URL` with `IP_OPENCODE_PASSWORD`.
- `disabled`: agent endpoints return 503; the deterministic pipeline is unaffected (CI uses this).

### Model selection

`GET /api/agent/models` lists models; `PUT /api/agent/model` stores a selection only if the
exact identifier exists and is enabled. Agent jobs record the model they were created with;
at run time the adapter re-resolves it and **fails the job** if it is missing — it never
falls back to another model.

### Workflow (`agents/workflow.py`)

1. Evidence pack (≤ 30 KB): repository metadata, coverage, languages, frameworks,
   manifests, entry points, routes, scripts, central files, most-referenced symbols,
   dependencies, exported symbols with signatures, documentation section index and a
   bounded README excerpt — each item with its evidence ID; repository text is labelled
   untrusted.
2. Up to 4 rounds. Each round the model returns exactly one JSON object:
   `request_evidence` (1–8 tool requests) or `final` (sections of claims with evidence IDs).
   Gateway budget: 24 requests, 120 KB; reads capped at 120 lines.
3. Output parsing takes the first complete JSON object; if that fails, a string-aware
   bracket repair is attempted (a live model response once omitted a closing `]`), then one
   corrective retry with the parse error.
4. Validation (see [EVIDENCE_CONTRACT.md](EVIDENCE_CONTRACT.md)) and report persistence.

### Error normalisation

401 → `AgentUnavailable(unauthorized)`, 503 → `service_unavailable`, 400 →
`AgentError(invalid_request)`, 404 → `not_found`, timeouts/connection errors →
`AgentUnavailable`. Cancellation closes the HTTP client (client-side); whether OpenCode
aborts the upstream model request on disconnect is not verified.

### Usage metrics

The generate endpoint returns text only. Reports record rounds, model calls, latency,
prompt/response characters, retries and gateway usage. Token counts and cost are **not**
available through this endpoint.

## Recorded live run

Repository `pallets/itsdangerous` @ `672971d66a2ef9f85151e53283113f33d642dabd`, model
`openai/gpt-5.6-terra`: first attempt failed on malformed JSON (fixed as above); second
attempt succeeded in 1 model call (~44 s), 20 claims, 71/71 cited evidence verified,
0 unsupported, 5 labelled documentation-only. The model did not request extra evidence in
that run; the request path is covered by mocked integration tests.

## Re-verifying after an OpenCode upgrade

1. `opencode --version`; fetch `/openapi.json` and confirm the six endpoints and schemas.
2. Re-run the canary probe (ask the generate endpoint to read a file in its cwd).
3. Run `.\scripts\test.ps1 -Live`.

## Q&A protocol (M4)

`agents/qa.py` runs per question: intent detection → hybrid retrieval → focus symbols (every explicitly
named symbol, then the top hit) → usage/impact/flow facts with evidence IDs → bounded excerpts → generate.
The model answers with the same JSON protocol as reports (`request` actions executed by the read-only
gateway, at most 3 rounds, or a final `answer` with claims). Prior turns are summarised into the prompt.
Claims are validated against the conversation's snapshot and each answer records a grounding status.

The model is whatever is configured (recorded with each run). If it is unavailable the job fails with a
clear error; the backend never switches models.

### Recorded live Q&A (2026-11-18, `openai/gpt-5.6-terra`)
- pallets/itsdangerous snapshot 2: turn 1 grounded (8/8 source claims, 3 rounds, 13 gateway requests);
  the follow-up was grounded (7/7) and used the previous turn as context.
- Benchmark `--live`: 2 questions, 9/9 claims cite valid evidence.
