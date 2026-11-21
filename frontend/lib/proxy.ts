// Same-origin proxy from the Next.js server to the local FastAPI backend.
//
// Replaces a `rewrites()` rule. A rewrite answers a refused connection with a bare
// "500 Internal Server Error", which the UI could only show verbatim. This proxy reports
// *why* a request could not be served (backend not running, timed out) as a structured
// 503/504 in the backend's own error format, so the UI can explain what to do next.
//
// Security: the upstream origin is fixed (IP_BACKEND_URL, default 127.0.0.1:8000) and only the
// path below /api is taken from the request, so a caller cannot redirect requests or cookies
// to another host. Only the headers the backend uses are forwarded.

export const DEFAULT_BACKEND = "http://127.0.0.1:8000";
export const UPSTREAM_TIMEOUT_MS = 120_000;

const FORWARD_REQUEST_HEADERS = ["accept", "authorization", "content-type", "cookie", "x-ip-csrf", "user-agent"];
const FORWARD_RESPONSE_HEADERS = ["content-type", "content-disposition", "cache-control", "retry-after", "x-request-id"];

export function backendOrigin(): string {
  return (process.env.IP_BACKEND_URL ?? DEFAULT_BACKEND).replace(/\/$/, "");
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

/** True when the failure means nothing is listening (or the host is unreachable), not an HTTP error. */
function isConnectionFailure(err: unknown): boolean {
  const codes = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i++) {
    const code = (cur as { code?: string }).code;
    if (code && codes.has(code)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

export async function proxyToBackend(
  request: Request,
  segments: string[],
  origin = backendOrigin(),
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  if (segments.some((s) => s === ".." || s === "." || s.includes("\\"))) {
    return errorResponse(400, "bad_path", "Invalid API path.");
  }
  const incoming = new URL(request.url);
  const target = `${origin}/api/${segments.map(encodeURIComponent).join("/")}${incoming.search}`;

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = request.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetchImpl(target, { method, headers, body, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if ((err as { name?: string }).name === "TimeoutError") {
      return errorResponse(504, "backend_timeout", `The backend at ${origin} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    if (isConnectionFailure(err)) {
      return errorResponse(
        503,
        "backend_unavailable",
        `The Ingestion-Pipeline backend is not running or not reachable at ${origin}. Start it with scripts\\start-backend.ps1 (or "uv run python -m uvicorn app.main:app_factory --factory --port 8000" in backend\\).`,
      );
    }
    console.error("[api proxy] unexpected upstream failure:", (err as Error)?.message ?? err);
    return errorResponse(502, "backend_proxy_error", `The request to the backend at ${origin} failed unexpectedly. See the frontend server log for details.`);
  }

  const out = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const v = upstream.headers.get(name);
    if (v !== null) out.set(name, v);
  }
  for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie);
  return new Response(method === "HEAD" ? null : upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}
