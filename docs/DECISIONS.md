# Decision log

| # | Decision | Reason | Alternatives considered |
|---|---|---|---|
| 1 | OpenCode stateless `POST /api/experimental/generate` is the only inference path | No tool loop → the model cannot touch the filesystem or shell; the backend owns all reads | OpenCode sessions with deny-all permissions (still a tool-capable agent loop); automating the TUI (forbidden) |
| 2 | Model may *request* evidence via JSON; backend executes read-only gateway | Gives investigation ability while keeping enforcement in our code | MCP server exposed to an OpenCode session (larger surface, harder to prove read-only) |
| 3 | Python parsed with stdlib `ast`; TS/JS with Tree-sitter | `ast` is exact for Python and has no dependency; Tree-sitter is robust for TS/TSX/JSX with error recovery | Tree-sitter for Python too; regex (rejected) |
| 4 | SQLite (WAL) + in-process worker with atomic claim and leases | Zero infrastructure on Windows; correct single-claim semantics | Celery/Redis (unneeded), separate worker process (possible later; the claim logic already supports it) |
| 5 | Snapshots keep the working tree only; `.git` deleted after metadata extraction | Smaller, immutable, nothing for later tooling to execute | Keeping bare repos for incremental fetch (M3 candidate) |
| 6 | Cache key = (repository, commit SHA, analyzer version); no forced in-place re-analysis | Forced re-analysis could corrupt the current snapshot on failure | `force` flag (removed) |
| 7 | Basis of agent claims computed by backend from cited evidence kinds | The model must not grade its own evidence | Trusting model-provided labels |
| 8 | Unresolved calls on dynamic receivers are counted, not stored as edges | Avoids flooding the graph with guesses; unresolved *names* are stored explicitly | Storing every `x.y()` as unresolved |
| 9 | Build SQLAlchemy and mypy from source (pure Python) | Windows Smart App Control blocked their unsigned compiled extensions; pure-Python variants are official and portable | Asking users to disable App Control |
| 10 | Report "not observed" instead of "unused" for dependencies | Static import scanning cannot prove absence of use | — |
| 11 | Frontend pages are server shells around client views in `<Suspense>` | Required by Next.js 16 Cache Components for `useParams`/`useSearchParams` | Disabling Cache Components |
| 12 | Next.js routes are confirmed only when `next` is a declared dependency | Avoid inferring behaviour from filenames alone | Path-only detection |
