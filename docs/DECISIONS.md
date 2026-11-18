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
| 13 | Worker runs as a separate process supervised by the API, each job in its own spawned child | A crashing or hung job cannot take down the API; timeouts and cancellation can kill reliably | Threads (no forced kill); Celery (infrastructure) |
| 14 | Local token + HttpOnly session cookie, CSRF header, same-origin `/api` proxy | Protects the API from other local origins and DNS rebinding without user accounts | OAuth (overkill locally); no auth (M2) |
| 15 | Windows Job Objects for git/OpenCode/worker, documented as resource limits, not a sandbox | Works without admin rights, WSL or Docker; honest about what it enforces | AppContainer (more setup); Docker (not allowed as a requirement) |
| 16 | Evidence contract 1.1 adds the analyzer version to IDs; snapshot uniqueness includes analyzer version | Re-analysing a commit with a newer analyzer must not overwrite or collide with old evidence | Overwriting snapshots in place |
| 17 | Ambiguous dispatch produces edges to every override, marked `ambiguous` | Shows possible targets without claiming one | Picking the base method only |
| 18 | Hybrid retrieval is deterministic and explainable (scored signals), no embeddings | No paid services or model downloads; results can be explained in the UI | Vector search |
| 19 | Q&A focus covers every explicitly named symbol; impact depth 5 | Live runs showed answers missing a route four hops away when only the top hit was analysed | Top hit only |
