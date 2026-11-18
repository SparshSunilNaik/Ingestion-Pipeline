// Captures documentation screenshots from a running instance (real data; nothing is mocked).
// Usage: BASE=http://127.0.0.1:3100 TOKEN=<token> SNAPSHOT=1 FILE=src/pkg/mod.py SYMBOL="sym:src/pkg/mod.py#Cls.method" CONV=1 //        node e2e/capture-screenshots.mjs
import { chromium } from "@playwright/test";
import path from "node:path";

const base = process.env.BASE ?? "http://127.0.0.1:3100";
const token = process.env.TOKEN;
const snap = process.env.SNAPSHOT ?? "1";
const file = process.env.FILE ?? "src/itsdangerous/signer.py";
const symbol = process.env.SYMBOL ?? "sym:src/itsdangerous/signer.py#Signer.get_signature";
const conv = process.env.CONV ? `&c=${process.env.CONV}` : "";
const out = path.resolve(process.env.OUT ?? "../docs/screenshots");
if (!token) throw new Error("TOKEN is required");
const e = encodeURIComponent;

const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`${base}/login`);
await page.getByLabel("API token").fill(token);
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL(`${base}/`);

const ws = `/snapshots/${snap}?`;
const shots = [
  ["home", "/"],
  ["overview", `${ws}view=overview${conv}`],
  ["code-explorer", `${ws}view=code&file=${e(file)}&sym=${e(symbol)}${conv}`],
  ["impact", `${ws}view=symbol&key=${e(symbol)}&section=impact${conv}`],
  ["architecture", `${ws}view=architecture&gview=files`],
  ["execution-flow", `${ws}view=flow&entry=${e(symbol)}`],
  ["report", `${ws}view=report`],
  ["analysis-progress", "/jobs/1"],
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
