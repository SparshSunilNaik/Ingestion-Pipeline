# Evidence contract (v1.0)

Source: `backend/app/evidence/contract.py`, `collector.py`, `verifier.py`;
reports: `backend/app/reports/schema.py`.

## Evidence record

| Field | Meaning |
|---|---|
| `id` | `ev_` + first 24 hex of SHA-256 over (contract version, commit SHA, path, start, end, category, method, subject). Stable: same extraction on the same commit → same ID. |
| `repository_id`, `snapshot_id`, `commit_sha` | The exact immutable snapshot the location refers to |
| `path` | Repository-relative POSIX path of an **analysed** file |
| `start_line`, `end_line` | 1-based inclusive range, clamped to the file at creation |
| `category` | `symbol_definition`, `import`, `call`, `route`, `framework_usage`, `dependency_declaration`, `entry_point`, `documentation`, `configuration`, `test`, `ci`, `container`, `retrieved_source` |
| `extraction_method` | `python_ast`, `tree_sitter`, `manifest_parser`, `inventory`, `doc_section`, `gateway_read` |
| `analyzer_version`, `contract_version` | Versions that produced the record |
| `verification_status` | `verified` when the range was checked against file content at creation |
| `source_kind` | `source`, `test`, `documentation`, `configuration`, `manifest` (from file classification) |
| `limitations` | Free-text caveats (e.g. "documentation claim; not verified against implementation") |
| `excerpt_sha256` | Hash of the exact lines; used to detect drift |

## Verifier

`verify_evidence()` rejects a record unless: it belongs to the given snapshot and commit;
the path is syntactically safe, present in the snapshot inventory, analysed, and readable
inside the snapshot root; the range is valid for the file; and the excerpt hash matches.
`verify_location()` applies the same checks to arbitrary `(path, start, end)` — used for
model-supplied locations and exposed at `POST /api/snapshots/{id}/verify-location`.

## Claims

Every report statement is a `Claim{statement, basis, evidence_ids, note}`.

| Basis | Assigned when |
|---|---|
| `source_evidence` | at least one cited evidence item is implementation source or test code |
| `configuration_evidence` | cited evidence is manifests/configuration only |
| `documentation_claim` | cited evidence is documentation only — *the code was not checked* |
| `inventory_measured` | deterministic statistic of the inventory |
| `heuristic` | deterministic judgement (e.g. "no CI found" → risk); not a proven fact |
| `unknown` | could not be determined; stated explicitly rather than guessed |
| `unsupported` | an agent claim whose cited IDs are missing, invalid or from another snapshot |

For agent output the basis is **computed by the backend** from the cited records, never
taken from the model. Before a report is saved, every cited ID is re-verified; IDs that
fail are removed from the claim, and the report records `evidence_summary` counts.

"Source evidence" means the claim points at real code; it does not prove the sentence is a
correct interpretation of that code. The UI makes every citation one click away from the
highlighted source range so a reader can check.
