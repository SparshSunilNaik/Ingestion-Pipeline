// Captures documentation screenshots from a running instance.
// Usage: BASE=http://127.0.0.1:3100 TOKEN=<token> SNAPSHOT=3 node e2e/capture-screenshots.mjs
import { chromium } from "@playwright/test";
import path from "node:path";

const base = process.env.BASE ?? "http://127.0.0.1:3100";
const token = process.env.TOKEN;
const snap = process.env.SNAPSHOT ?? "3";
const out = path.resolve(process.env.OUT ?? "../docs/screenshots");
if (!token) throw new Error("TOKEN is required");

const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`${base}/login`);
await page.getByLabel("API token").fill(token);
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL(`${base}/`);

const shots = [
  ["dashboard", "/"],
  ["overview", `/snapshots/${snap}?view=overview`],
  ["code-explorer", `/snapshots/${snap}?view=code&file=svc%2Fcore%2Fauth.py&l=9-13&sym=sym%3Asvc%2Fcore%2Fauth.py%23login`],
  ["architecture-calls", `/snapshots/${snap}?view=architecture&gview=calls&node=sym%3Asvc%2Fcore%2Ftokens.py%23issue_token`],
  ["execution-flow", `/snapshots/${snap}?view=architecture&gview=flows&entry=${encodeURIComponent("route:POST /login@svc/api/app.py:8")}`],
  ["impact", `/snapshots/${snap}?view=architecture&gview=focus&focus=${encodeURIComponent("sym:svc/core/models.py#Account.validate")}&tab=impact`],
  ["investigate", `/snapshots/${snap}?view=investigate&c=1`],
  ["report", `/snapshots/${snap}?view=report`],
  ["compare", `/snapshots/${snap}?view=compare`],
];
for (const [name, url] of shots) {
  await page.goto(base + url);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log("captured", name);
}
await page.emulateMedia({ colorScheme: "light" });
await page.evaluate(() => localStorage.setItem("ip.theme", "light"));
await page.goto(`${base}/snapshots/${snap}?view=overview`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(out, "overview-light.png") });
console.log("captured overview-light");
await browser.close();
