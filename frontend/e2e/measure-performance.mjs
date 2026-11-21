// Measures real page loads against a running production build (no mocks).
// Usage: BASE=http://127.0.0.1:3300 TOKEN=<token> SNAPSHOT=1 PW_CHANNEL=msedge node e2e/measure-performance.mjs
import { chromium } from "@playwright/test";

const base = process.env.BASE ?? "http://127.0.0.1:3300";
const token = process.env.TOKEN;
const snap = process.env.SNAPSHOT ?? "1";
if (!token) throw new Error("TOKEN is required");

const pages = [
  ["landing", "/"],
  ["overview", `/snapshots/${snap}?view=overview`],
  ["source", `/snapshots/${snap}?view=code&file=src%2Fitsdangerous%2Fsigner.py&l=215-220`],
  ["architecture (calls)", `/snapshots/${snap}?view=architecture&gview=calls`],
];

const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const login = await ctx.newPage();
await login.goto(`${base}/login`);
await login.getByLabel("API token").fill(token);
await login.getByRole("button", { name: "Sign in" }).click();
await login.waitForURL(`${base}/`);
await login.close();

const rows = [];
for (const [name, url] of pages) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");
  const t0 = Date.now();
  await page.goto(base + url, { waitUntil: "networkidle" });
  const ready = Date.now() - t0;
  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const res = performance.getEntriesByType("resource");
    const js = res.filter((r) => r.name.endsWith(".js"));
    const lcp = performance.getEntriesByType("largest-contentful-paint").at(-1);
    let cls = 0;
    for (const e of performance.getEntriesByType("layout-shift")) if (!e.hadRecentInput) cls += e.value;
    return {
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
      jsKB: Math.round(js.reduce((a, r) => a + (r.encodedBodySize || 0), 0) / 1024),
      elk: js.some((r) => /elk/i.test(r.name)) || null,
      lcp: lcp ? Math.round(lcp.startTime) : null,
      cls: Math.round(cls * 1000) / 1000,
    };
  });
  const heap = (await cdp.send("Performance.getMetrics")).metrics.find((x) => x.name === "JSHeapUsedSize")?.value ?? 0;
  rows.push({ page: name, ...m, networkIdleMs: ready, heapMB: Math.round(heap / 1048576) });
  await page.close();
}
console.table(rows);
await browser.close();
