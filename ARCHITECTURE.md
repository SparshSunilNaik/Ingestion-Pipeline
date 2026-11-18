# Architecture

## Overview

```
 Browser (Next.js workspace)
        │  JSON over HTTP (CORS: localhost:3000)
        ▼
 FastAPI app ──────────────┬──────────────────────────────────────────────┐
  api/routes.py            │ in-process Worker thread (ingestion/worker)  │
        │                  │   claims jobs atomically from SQLite         │
        ▼                  ▼                                              │
 SQLite (WAL, FKs, FTS5) ◄── IngestionPipeline ──► GitRunner (hardened git)│
   repositories, snapshots,   resolve → cache? → clone → inventory →      │
   jobs, files, symbols,      promote → SnapshotAnalyzer → report         │
   evidence, graph_nodes,                                                 │
   graph_edges, dependencies, ◄── InvestigationWorkflow ──► OpenCodeAdapter ──► opencode serve
   findings, reports,              (agent_report jobs)        stateless      (managed, 127.0.0.1,
   app_settings, file_fts          ▲        │                 generate       random password,
                                   │        ▼                                 empty sandbox cwd)
                              ReadOnlyGateway (evidence tools)
 Snapshot store: backend/data/snapshots/<owner>/<repo>/<commit-sha>/  (working tree only)
```

## Backend modules (`backend/app`)

| Package | Responsibility |
|---|---|
| `core` | Settings (`IP_*` env vars), structured logging with secret redaction, domain errors → HTTP |
| `database` | SQLAlchemy models, SQLite engine (WAL, `foreign_keys=ON`, busy timeout), Alembic runner |
| `ingestion` | URL validation, hardened git, file classification, inventory, job queue, pipeline, worker |
| `analysis` | Language analyzers (Python `ast`, Tree-sitter TS/JS), manifest parsers, doc sectioning, import resolution, `SnapshotAnalyzer` orchestration |
| `graph` | `GraphBuilder` (NetworkX `MultiDiGraph`), node/edge key scheme, centrality helpers |
| `evidence` | Contract (IDs, enums), collector (verifies while creating), verifier (path + range + excerpt hash) |
| `search` | FTS5 index and safe query construction |
| `agents` | OpenCode adapter, managed runtime, read-only gateway, investigation workflow, agent jobs |
| `reports` | Report schema, deterministic builder, Markdown renderer |
| `schemas` | Typed API contracts |

## Ingestion flow

1. `POST /api/jobs` validates the URL (rejects non-repository URLs before any network
   access) and enqueues a job; an active job for the same repository is reused.
2. The worker claims the oldest queued job with a single `UPDATE … WHERE status='queued'
   RETURNING id` and renews a lease while running. Expired leases are requeued (max 3
   attempts) so interrupted jobs recover after a crash.
3. `git ls-remote` resolves HEAD. If a `ready` snapshot exists for that SHA and analyzer
   version, it is reused (no clone).
4. Shallow clone into `data/staging/job-*`; record SHA, branch, tracked entries (with
   modes, so symlinks/submodules are known), recent commits; enforce storage budget;
   delete `.git`.
5. Inventory and classification; select files to analyse within limits.
6. Atomic `os.replace` into `data/snapshots/<owner>/<repo>/<sha>`.
7. `SnapshotAnalyzer` parses, resolves, builds the graph, collects evidence, indexes FTS.
8. The deterministic report is built; only then does the repository's
   `current_snapshot_id` move to the new snapshot. Any failure rolls back, deletes the
   new snapshot row/directory and leaves the previous snapshot untouched.

## Analysis model

- **IR** (`analysis/ir.py`): `SymbolInfo`, `ImportInfo` (+ bindings), `CallInfo`,
  `RouteInfo`, `EntryPointInfo` per file. New languages implement `LanguageAnalyzer`.
- **Resolution** (`analysis/resolver.py`): Python modules indexed by every path suffix
  (handles `src/` and nested layouts), relative imports, submodule-vs-attribute
  disambiguation; JS/TS relative paths, index files, `.js`→`.ts` ESM mapping and
  `tsconfig`/`jsconfig` `paths` aliases; stdlib/builtin detection.
- **Graph keys**: `file:<path>`, `sym:<path>#<qualname>`, `pkg:<ecosystem>:<name>`,
  `route:<METHOD path>@<file>:<line>`, `unresolved:<kind>:<name>`.
  Edge kinds: `contains`, `imports`, `calls`, `inherits`, `declares_route`, `handled_by`,
  `declares_dependency`. Each edge stores resolution status, evidence ID and count.
- **Dependencies**: declared (manifests) vs imported (resolved external imports) →
  `observed_import`, `not_observed`, `undeclared_import`.

## Agent model

The model never touches the repository. The backend sends a bounded evidence pack and a
JSON protocol; the model may answer with read-only *requests* (read range, search,
symbol lookup, directory listing, graph neighbours) that the backend executes and
returns, or with a final report. Final claims are validated against the evidence table
and the snapshot on disk. See [docs/OPENCODE_INTEGRATION.md](docs/OPENCODE_INTEGRATION.md).

## Frontend (`frontend/`)

Next.js 16 App Router with Cache Components enabled. Each route's `page.tsx` is a server
component that renders a client view inside `<Suspense>`; data comes from the backend at
runtime via `lib/api.ts`. The architecture tab renders a React Flow graph (dagre layout)
of the persisted graph and a Mermaid diagram generated from resolved import edges.
