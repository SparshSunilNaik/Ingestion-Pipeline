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
- (Superseded in M5: the API now requires token/session authentication — see below. It
  should still be bound to localhost only; the scripts do.)
- Symlink-escape tests for `resolve_inside` are skipped on Windows hosts without the
  symlink privilege (they run in Linux CI).

## M5 additions

### Authentication (local-first)
- Every endpoint except `/api/health*` and `/api/auth/*` requires authentication (verified by tests that probe
  repositories, jobs, agent status and mutations without credentials → 401).
- Token: 32-byte random value in `backend/data/api-token`, written once with an ACL that removes inheritance and
  grants only the current user (`icacls`, verified by a test) or mode 0600 on POSIX. Optional `IP_API_TOKEN`.
- Browser sessions: `POST /api/auth/login` exchanges the token for a random session secret in an
  `HttpOnly; SameSite=Strict` cookie; only its SHA-256 is stored (`api_sessions`), with expiry (12 h default).
- CSRF: cookie-authenticated non-GET requests must send `X-IP-CSRF: 1` (cross-site forms cannot set headers).
- Login rate limit: 5 failures per minute per client → 429. Request bodies over 256 KB → 413.
- `TrustedHostMiddleware` rejects non-local `Host` headers (DNS-rebinding defence). The frontend proxies `/api`
  same-origin, so no cross-origin credentials are needed.

### Process isolation (implemented and tested)
- Windows: git, the managed OpenCode server and the worker process run inside **Job Objects** — started suspended,
  assigned, then resumed (no escape window). Limits: per-process committed memory (git: 2 GB default), active
  process count (git: 32), and **kill-on-close** so children die with their owner. Tests verify job membership,
  limits, `MemoryError` under the memory cap, process-count enforcement and termination on close; a live check
  confirmed the OpenCode server exits when the backend is killed.
- POSIX: `RLIMIT_AS`/`RLIMIT_NPROC` and a new session for git children.
- Staging directories get a user-only ACL before cloning.
- The worker executes each job in its own child process with a per-kind timeout; forced cancellation and timeouts
  kill the child.

### Residual risks (unchanged or new)
- Job Objects limit resources; they are **not** a sandbox. git and OpenCode keep the user's file-system and network
  access. No AppContainer / low-integrity token is applied (investigated; not implemented).
- The worker subprocess receives the managed OpenCode password via its environment (same user, same trust boundary).
- The API token file is readable by the user's account and by administrators.
- Q&A answers are validated for evidence existence, not for semantic truth.

## M6: additional isolation investigated (not implemented)

Goal: stronger confinement of git and OpenCode **without administrator rights, WSL or Docker**.

| Option | Feasible without admin? | Finding |
|---|---|---|
| Low integrity level token (`CreateRestrictedToken` + `SetTokenInformation(TokenIntegrityLevel)`) for git | Yes | Blocks writes to medium-integrity locations (the user profile, the repository checkout, the database). The staging directory would need a low-integrity label (`icacls … /setintegritylevel low`, allowed on objects the user owns). This is the most promising next step for git. Not implemented in M6: it needs careful handling of git's temp/home directories and Windows-only tests. |
| AppContainer (`CreateAppContainerProfile` + `SECURITY_CAPABILITIES`) | Yes (per-user profile) | Strongest confinement, but every path git reads/writes and the network capability must be granted explicitly, and OpenCode needs the user's own configuration and provider credentials, which an AppContainer cannot reach without broad grants. Judged too intrusive for M6. |
| Windows Sandbox / Hyper-V / containers | No (feature enablement or admin) | Out of scope by requirement. |
| Egress filtering (Windows Firewall rules) | No (admin) | Out of scope. |

Unchanged residual risk: Job Objects limit memory, process count and lifetime only. git and OpenCode keep the
user's file-system and network access. The analysis never executes repository code and the model has no tools,
which remain the primary controls.

## M6: UI and assistant
- Conversations are bound to one snapshot: the assistant ignores a conversation ID from another snapshot, and
  answers are validated against the conversation's snapshot only (unchanged backend rule).
- Contextual questions put the selected symbol's name and location into the question text; they do not grant
  the model any additional access.
- The API token is never shown or stored by the UI; it is exchanged once for an HttpOnly session cookie.

## M7: /api proxy
The frontend forwards `/api/*` through `frontend/lib/proxy.ts` instead of a Next.js rewrite. The upstream
origin is fixed (`IP_BACKEND_URL`, default `http://127.0.0.1:8000`); only the path below `/api` comes from the
request (traversal segments rejected, segments URL-encoded), so requests and cookies cannot be redirected to
another host. Only `accept`, `authorization`, `content-type`, `cookie`, `x-ip-csrf` and `user-agent` are
forwarded upstream; only content/download headers and `Set-Cookie` come back. Failures are reported as
structured 503/504 without stack traces.

