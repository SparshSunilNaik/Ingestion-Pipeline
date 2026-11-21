# Troubleshooting

## The page shows "The backend is not running" (formerly "500 Internal Server Error")

**Cause.** The frontend (port 3000) is running but the backend (port 8000) is not. Every `/api` request
is forwarded by the frontend to the backend; when nothing listens on 8000 the request cannot be served.

Until M7 the frontend used a Next.js rewrite for this forwarding. A rewrite answers a refused connection
with a bare `500 Internal Server Error`, and the UI displayed exactly that text with no explanation. This
is what the owner saw after the backend process (started from an assistant session) had stopped while the
frontend kept running.

**Fix (M7).** `/api` is now forwarded by a route handler (`frontend/app/api/[...path]/route.ts`,
`frontend/lib/proxy.ts`) that reports an unreachable backend as `503 backend_unavailable` and a slow one
as `504 backend_timeout`. The UI shows a page that names the backend address, gives the start command and
re-checks every few seconds; starting the backend is enough to recover, no reload needed.
Regression tests: `frontend/test/proxy.test.ts` (real sockets: refused connection, timeout, pass-through
of status, cookies, downloads; header allow-list; path traversal) and `frontend/test/backend-status.test.tsx`.

**What to do.** Start the backend:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-backend.ps1
```

or start everything at once (each in its own window):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-dev.ps1
```

Check the state with `scripts\health.ps1`; stop the project's servers (and only those) with
`scripts\stop-dev.ps1`.

## "The backend hit an unexpected error"

The backend returned `500 internal_error`. The traceback is in the backend window/log (never in the UI).
Retry; if it repeats, note the request in the browser's network tab and the time, and check the log.

## Other checks

| Symptom | Check |
|---|---|
| Sign-in page keeps returning | The token in `backend\data\api-token` changed or the session expired (12 h). Sign in again. |
| Assistant says the model is not available | `scripts\health.ps1` → `[agent]` line; OpenCode must be installed and the configured model enabled. Static analysis keeps working. |
| Port already in use | `Get-NetTCPConnection -State Listen -LocalPort 8000` shows the owning process; stop only project processes. |
| Frontend shows stale UI after `git pull` | Restart `start-frontend.ps1`; delete `frontend\.next` only if the restart does not help. |
