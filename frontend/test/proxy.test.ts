// @vitest-environment node
// Regression tests for the "500 Internal Server Error" seen when the backend was not running:
// the /api proxy must report an unreachable backend as a structured 503, and otherwise be a
// faithful, header-restricted pass-through. Uses real sockets, no fetch mocks.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proxyToBackend } from "@/lib/proxy";

let server: Server;
let origin = "";
const seen: { method?: string; url?: string; headers?: IncomingMessage["headers"]; body?: string } = {};

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      Object.assign(seen, { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url?.startsWith("/api/slow")) return; // never answers
      if (req.url?.startsWith("/api/report")) {
        res.writeHead(200, { "content-type": "text/markdown", "content-disposition": 'attachment; filename="r.md"', "x-internal": "secret" });
        return res.end("# Report");
      }
      res.writeHead(req.url?.startsWith("/api/missing") ? 404 : 200, {
        "content-type": "application/json",
        "set-cookie": ["ip_session=abc; HttpOnly; SameSite=Strict; Path=/", "other=1; Path=/"],
      });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** A port that was just free: connecting to it is refused, like a stopped backend. */
async function closedPort(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

describe("/api proxy", () => {
  it("reports a stopped backend as 503 backend_unavailable with instructions, not a bare 500", async () => {
    const res = await proxyToBackend(new Request("http://localhost:3000/api/repositories"), ["repositories"], await closedPort());
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.error.code).toBe("backend_unavailable");
    expect(body.error.message).toMatch(/not running or not reachable/);
    expect(body.error.message).toMatch(/start-backend\.ps1/);
  });

  it("reports a backend that does not answer as 504 backend_timeout", async () => {
    const res = await proxyToBackend(new Request("http://localhost:3000/api/slow"), ["slow"], origin, { timeoutMs: 300 });
    expect(res.status).toBe(504);
    expect((await res.json()).error.code).toBe("backend_timeout");
  });

  it("passes status, body, query and every session cookie through", async () => {
    const res = await proxyToBackend(new Request("http://localhost:3000/api/missing/x?limit=5"), ["missing", "x"], origin);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen.url).toBe("/api/missing/x?limit=5");
    expect(res.headers.getSetCookie()).toEqual(["ip_session=abc; HttpOnly; SameSite=Strict; Path=/", "other=1; Path=/"]);
  });

  it("forwards only the headers the backend uses, and the request body", async () => {
    const req = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ token: "t" }),
      headers: { "content-type": "application/json", "x-ip-csrf": "1", cookie: "ip_session=abc", "x-forwarded-host": "evil.example", "x-other": "1" },
    });
    const res = await proxyToBackend(req, ["auth", "login"], origin);
    expect(res.status).toBe(200);
    expect(seen.method).toBe("POST");
    expect(seen.body).toBe('{"token":"t"}');
    expect(seen.headers?.["x-ip-csrf"]).toBe("1");
    expect(seen.headers?.cookie).toBe("ip_session=abc");
    expect(seen.headers?.["x-forwarded-host"]).toBeUndefined();
    expect(seen.headers?.["x-other"]).toBeUndefined();
  });

  it("keeps download headers and drops internal ones", async () => {
    const res = await proxyToBackend(new Request("http://localhost:3000/api/report"), ["report"], origin);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="r.md"');
    expect(res.headers.get("x-internal")).toBeNull();
    expect(await res.text()).toBe("# Report");
  });

  it("rejects path traversal and never leaves the configured backend", async () => {
    expect((await proxyToBackend(new Request("http://localhost:3000/api/x"), ["..", "secret"], origin)).status).toBe(400);
    await proxyToBackend(new Request("http://localhost:3000/api/x"), ["http:", "", "evil.example"], origin);
    expect(seen.url).toBe("/api/http%3A//evil.example");
  });
});
