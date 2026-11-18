# Security

Repository contents are untrusted. Nothing from an analysed repository is executed, and
the AI model receives no tool access. This document lists what is enforced in code, how
it is tested, and what remains.

## Threat model

| Threat | Examples |
|---|---|
| Malicious URL input | credentials in URL, other hosts/schemes, `ext::` transports, path traversal |
| Malicious repository content | git hooks, LFS/filter drivers, submodules, symlinks to host files, NTFS reserved/ADS names, huge files, binaries, setup scripts |
| Resource exhaustion | giant repos, slow remotes, millions of files |
| Prompt injection | README/code text instructing the model to fabricate claims or take actions |
| Model hallucination | invented paths, line numbers, evidence IDs |
| Secret leakage | OpenCode credentials, account headers, git credentials in logs |

## Enforced controls

**URL validation** (`ingestion/url.py`): `https` only; host `github.com`/`www.github.com`;
no userinfo, port, query, fragment, `%`, `\`, whitespace, control or non-ASCII chars;
exactly `/<owner>/<repo>[.git]`; GitHub owner/name grammar; `.`/`..` rejected.

**Git hardening** (`ingestion/git_ops.py`):
- isolated config: `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<empty file>`, sandboxed `HOME`;
  only a small allow-list of environment variables is inherited;
- `core.hooksPath=<empty dir>`, empty `--template`;
- `GIT_TERMINAL_PROMPT=0`, empty askpass, `credential.helper=`;
- `GIT_LFS_SKIP_SMUDGE=1`, LFS filter disabled;
- `--no-recurse-submodules`, `submodule.recurse=false`;
- `core.symlinks=false` (links checked out as plain files), `core.protectNTFS/HFS=true`;
- `protocol.allow=never` + explicit allow for `https` (`GIT_ALLOW_PROTOCOL` too); `ext`/`fd` never;
- `transfer.fsckObjects=true`; shallow, single-branch, no tags;
- timeouts kill the whole process tree (`taskkill /T` on Windows, process group on POSIX).

**Snapshot isolation**: clones go to a staging directory, `.git` is deleted, then an
atomic rename promotes the working tree. Every file access resolves through
`resolve_inside()` which rejects unsafe path syntax, any symlink/junction component, and
anything whose real path leaves the snapshot root. Tracked symlinks (mode `120000`) and
submodules (`160000`) are classified from the git index and never read.

**Limits** (`IP_LIMIT_*`): analysed files, bytes per file, total bytes, commits, clone
timeout, storage budget, tracked-file count. Exceeding analysis budgets yields a
*partial-coverage* report; exceeding the storage budget fails the job.

**No execution**: manifests are parsed declaratively (`setup.py` is never evaluated);
`package.json` scripts are reported as text. A test plants payloads in `setup.py`,
`conftest.py`, `__init__.py` and `postinstall` and asserts none run.

**Agent boundary**: see [OPENCODE_INTEGRATION.md](OPENCODE_INTEGRATION.md). In short:
the adapter can call only six allow-listed OpenCode endpoints; the analysis workflow uses
only `POST /api/experimental/generate`, which performs a single model generation without
tools (verified with a canary-file probe). Evidence requests from the model are validated
(discriminated Pydantic union), executed by `ReadOnlyGateway` against analysed files of
the same snapshot only, line-capped and budgeted.

**Prompt injection**: repository text is labelled untrusted in the prompt, but the real
controls are structural: no tools, schema-validated output, evidence IDs re-verified
against disk, claims without valid evidence labelled `unsupported`, unknown section titles
dropped.

**Secrets**: the managed OpenCode server binds to `127.0.0.1` with a random per-process
password held only in memory. Model listings are copied field-by-field so provider
account headers are never returned. Logs pass through a redactor (auth headers, tokens,
passwords, URL userinfo). The API exposes no credential.

## Tests covering these controls

`backend/tests/security/test_security.py`, `tests/unit/test_url.py`,
`tests/unit/test_classify.py`, `tests/unit/test_opencode_adapter.py`,
`tests/integration/test_workflow.py`. Notable checks: a malicious inherited global git
config with a `post-checkout` hook — the control clone with plain git **does** run the hook,
our runner does not; protocol allow-list blocks `file://` and `ext::`; clone timeouts kill
the process; path traversal, ADS, reserved names, symlink escapes; fabricated evidence IDs
and evidence from another snapshot are rejected.

## Residual risks / not done

- The managed OpenCode process inherits the user's OpenCode configuration and
  credentials (needed to reach the model provider). It is not OS-sandboxed; the security
  boundary relies on the backend only calling the tool-less generate endpoint.
- `POST /api/experimental/generate` is marked *experimental* by OpenCode; its tool-less
  behaviour was verified empirically on v2.0.29, not by a documented guarantee. Re-run the
  canary probe after upgrading OpenCode.
- Network egress of the backend is not restricted at OS level (git needs github.com).
- Git itself parses untrusted pack data; we rely on upstream git security and fsck.
- The API has no authentication; bind it to localhost only (the scripts do).
- Symlink-escape tests for `resolve_inside` are skipped on Windows hosts without the
  symlink privilege (they run in Linux CI).
