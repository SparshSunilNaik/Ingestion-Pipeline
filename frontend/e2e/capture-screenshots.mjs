// Captures design-review / documentation screenshots from a running instance (real data; nothing mocked).
// Usage:
//   BASE=http://127.0.0.1:3100 TOKEN=<token> SNAPSHOT=1 CONV=1 OUT=../docs/screenshots SIZES=1920x1080,1366x768,1024x768 \
//   FILE=src/pkg/mod.py SYMBOL="sym:src/pkg/mod.py#Cls.method" NODE="file:src/pkg/mod.py" node e2e/capture-screenshots.mjs
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const base = process.env.BASE ?? "http://127.0.0.1:3100";
const token = process.env.TOKEN;
const snap = process.env.SNAPSHOT ?? "1";
const file = process.env.FILE ?? "src/itsdangerous/signer.py";
const symbol = process.env.SYMBOL ?? "sym:src/itsdangerous/signer.py#Signer.get_signature";
const node = process.env.NODE ?? "file:src/itsdangerous/signer.py";
const conv = process.env.CONV ? `&c=${process.env.CONV}` : "";
const out = path.resolve(process.env.OUT ?? "../docs/screenshots");
const sizes = (process.env.SIZES ?? "1920x1080").split(",").map((s) => s.split("x").map(Number));
if (!token) throw new Error("TOKEN is required");
fs.mkdirSync(out, { recursive: true });
const e = encodeURIComponent;
const ws = `/snapshots/${snap}?`;

const shots = [
  ["01-landing", "/"],
  ["02-overview", `${ws}view=overview`],
  ["03-architecture", `${ws}view=architecture&gview=files`],
  ["04-graph-selected", `${ws}view=architecture&gview=files&node=${e(node)}`],
  ["05-source", `${ws}view=code&file=${e(file)}&l=215-220&sym=${e(symbol)}`],
  ["06-execution-flow", `${ws}view=flow&entry=${e(symbol)}`],
  ["07-assistant", `${ws}view=code&file=${e(file)}&sym=${e(symbol)}${conv}`],
  ["08-report", `${ws}view=report`],
  ["09-compare", `${ws}view=compare`],
  ["10-impact", `${ws}view=symbol&key=${e(symbol)}&section=impact`],
  ["11-error-state", "/snapshots/999999"],
  ["12-analysis-progress", "/jobs/1"],
];

const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
for (const [w, h] of sizes) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(`${base}/login`);
  await page.getByLabel("API token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${base}/`);
  for (const [name, url] of shots) {
    await page.goto(base + url);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    const target = path.join(out, sizes.length > 1 ? `${name}-${w}x${h}.png` : `${name}.png`);
    await page.screenshot({ path: target });
    console.log("captured", path.basename(target));
  }
  await page.close();
}
await browser.close();
