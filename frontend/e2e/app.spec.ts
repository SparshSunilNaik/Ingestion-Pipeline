import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";
import { alert, login, noHorizontalOverflow, snapshots } from "./helpers";

async function benchWorkspace(page: Page, query = "") {
  await login(page);
  const ids = await snapshots(page);
  await page.goto(`/snapshots/${ids["acme/bench"][0]}${query}`);
  return ids;
}

/** Serious and critical WCAG A/AA violations (including colour contrast, which needs a real browser). */
async function seriousA11yViolations(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude(".react-flow__minimap").analyze();
  return res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test.describe("auth & shell", () => {
  test("redirects to login, rejects a wrong token, then signs in", async ({ page }) => {
    await page.goto("/repositories");
    await expect(page).toHaveURL(/\/login\?next=%2Frepositories/);
    await page.getByLabel("API token").fill("definitely-wrong");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(alert(page)).toContainText("Invalid API token");
    await login(page);
    await expect(page.getByText("acme/sample").first()).toBeVisible();
  });

  test("navigation, sidebar persistence and command palette", async ({ page }) => {
    await login(page);
    await page.getByRole("link", { name: "Repositories", exact: true }).click();
    await expect(page.getByText("snapshot history").first()).toBeVisible();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByText("OpenCode runtime")).toBeVisible();
    await page.getByRole("button", { name: /Collapse sidebar/ }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: /Expand sidebar/ })).toBeVisible();
    await page.getByRole("button", { name: /Expand sidebar/ }).click();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await page.getByLabel("Command palette search").fill("bench");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/snapshots\/\d+/);
  });
});

test.describe("home & analysis progress", () => {
  test("home lists repositories, continues the last workspace and has no serious a11y issues", async ({ page }) => {
    const ids = await benchWorkspace(page);
    await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
    await page.goto("/");
    const row = page.getByRole("row", { name: /acme\/bench/ });
    await expect(row).toContainText("python");
    await expect(page.getByRole("heading", { name: "Continue where you left off" })).toBeVisible();
    await page.getByRole("link", { name: /Reopen workspace/ }).click();
    await expect(page).toHaveURL(new RegExp(`/snapshots/${ids["acme/bench"][0]}`));
    await page.goto("/");
    await noHorizontalOverflow(page);
    expect(await seriousA11yViolations(page)).toEqual([]);
  });

  test("URL validation, submission, real stages and a recoverable failure", async ({ page }) => {
    await login(page);
    const input = page.getByLabel("GitHub repository URL");
    await input.fill("https://gitlab.com/a/b");
    await expect(page.getByText("Only github.com repositories are supported")).toBeVisible();
    await expect(page.getByRole("button", { name: /Analyse/ })).toBeDisabled();
    await input.fill("https://github.com/acme/does-not-exist-e2e");
    await expect(page.getByText(/Ready to analyse/)).toBeVisible();
    await page.getByRole("button", { name: /Analyse/ }).click();
    await expect(page).toHaveURL(/\/jobs\/\d+/);
    await expect(page.getByRole("list", { name: "Analysis stages" })).toContainText("Connecting to GitHub");
    // The test backend only allows file:// remotes, so the real clone attempt fails: the UI must explain it.
    await expect(page.getByText("Analysis failed")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText(/GitHub could not be reached/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Try again/ })).toBeVisible();
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    expect(await seriousA11yViolations(page)).toEqual([]);
  });
});

test.describe("workspace", () => {
  test("overview explains the repository; citations open exact source lines in a tab", async ({ page }) => {
    await benchWorkspace(page);
    await expect(page.getByRole("heading", { name: "What it does" })).toBeVisible();
    await expect(page.getByText("README states", { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Entry points & routes/ })).toBeVisible();
    const chip = page.locator("main [data-evidence-id]").first();
    await expect(chip).not.toContainText(/^ev_/);
    await chip.click();
    await expect(page).toHaveURL(/view=code/);
    await expect(page.locator("[data-highlighted]").first()).toBeVisible();
    await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible(); // context is kept as a tab
    expect(await seriousA11yViolations(page)).toEqual([]);
  });

  test("explorer search, source viewer, find-in-file, outline and callers", async ({ page }) => {
    await benchWorkspace(page);
    await page.keyboard.press("/");
    await page.getByRole("textbox", { name: "Search this repository" }).fill("check_password");
    await page.getByRole("button", { name: /check_password[\s\S]*svc\/core\/auth\.py/ }).first().click();
    const source = page.getByTestId("source-view");
    await expect(source).toContainText("def login(name: str, password: str)");
    await expect(page.locator("[data-highlighted]").first()).toBeVisible();
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Find in this file" }).fill("account");
    await expect(page.getByText(/1 of \d+ lines/)).toBeVisible();
    await page.getByRole("list", { name: "Symbols in this file" }).getByRole("button", { name: /^login/ }).click();
    await expect(page.getByText("Callers & references")).toBeVisible();
    await expect(page.getByRole("button", { name: /login_route/ }).first()).toBeVisible();
    await expect(page.getByText("Reached from routes")).toBeVisible();
    expect(await seriousA11yViolations(page)).toEqual([]);
  });

  test("symbol usage, dependencies and change impact with an impact graph", async ({ page }) => {
    await benchWorkspace(page, `?view=symbol&key=${encodeURIComponent("sym:svc/core/models.py#Account.validate")}&section=impact`);
    await expect(page.getByText(/Potentially affected, from static reachability/)).toBeVisible();
    const routes = page.locator("section", { has: page.getByRole("heading", { name: /Potentially affected routes/ }) });
    await expect(routes).toContainText("POST /login");
    await expect(page.getByTestId("impact-graph").locator(".react-flow__node").first()).toBeVisible();
    await page.getByRole("radio", { name: "Usage" }).click();
    await expect(page.getByText("Direct callers & references")).toBeVisible();
    await expect(page.getByRole("button", { name: "check_password" }).first()).toBeVisible();
    await page.getByRole("radio", { name: "Dependencies" }).click();
    await expect(page.getByText("Direct dependencies (calls & bases)")).toBeVisible();
  });

  test("architecture graph: directories drill into files, inspector, focus", async ({ page }) => {
    await benchWorkspace(page, "?view=architecture&gview=modules");
    const graph = page.getByTestId("graph-canvas");
    await expect(graph.locator(".react-flow__node").first()).toBeVisible();
    await graph.locator(".react-flow__node", { hasText: "svc/core" }).first().dblclick();
    await expect(page).toHaveURL(/gview=files&prefix=svc%2Fcore/);
    await expect(graph.locator(".react-flow__node", { hasText: "auth.py" }).first()).toBeVisible();
    await graph.locator(".react-flow__node", { hasText: "auth.py" }).first().click();
    await expect(page.getByText("Imported by").first()).toBeVisible();
    await page.getByRole("radio", { name: "Calls" }).click();
    await page.getByLabel("Find and focus a node").fill("Account.validate");
    await page.getByRole("button", { name: "Focus" }).first().click();
    await expect(page).toHaveURL(/gview=focus/);
    await expect(graph.locator(".react-flow__node", { hasText: "Account.validate" }).first()).toBeVisible();
  });

  test("execution flow from an entry point opens as its own context", async ({ page }) => {
    await benchWorkspace(page);
    await page.getByRole("tab", { name: "Entry points" }).click();
    await page.getByRole("button", { name: /POST \/login/ }).first().click();
    const steps = page.getByRole("list", { name: "Flow steps" });
    await expect(steps).toContainText("issue_token");
    await expect(steps).toContainText("sign");
    await expect(page.getByText("not observed runtime order")).toBeVisible();
    await expect(page.getByRole("tab", { name: /Flow POST \/login/ })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("radio", { name: "Graph" }).click();
    await expect(page.getByTestId("flow-graph").locator(".react-flow__node").first()).toBeVisible();
  });

  test("tabs survive navigation and a reload; closing a tab activates a neighbour", async ({ page }) => {
    const ids = await benchWorkspace(page);
    await page.goto(`/snapshots/${ids["acme/bench"][0]}?view=code&file=svc/core/auth.py`);
    await expect(page.getByTestId("source-view")).toBeVisible();
    await page.goto(`/snapshots/${ids["acme/bench"][0]}?view=report`);
    await page.reload();
    await expect(page.getByRole("tab", { name: "auth.py" })).toBeVisible();
    await page.getByRole("tab", { name: "auth.py" }).click();
    await expect(page.getByTestId("source-view")).toContainText("def login");
    await page.getByRole("tab", { name: "auth.py" }).press("Delete");
    await expect(page.getByRole("tab", { name: "auth.py" })).toHaveCount(0);
  });

  test("report renders with contents and exports", async ({ page }) => {
    await login(page);
    const ids = await snapshots(page);
    await page.goto(`/snapshots/${ids["acme/sample"][0]}?view=report`);
    await expect(page.getByRole("navigation", { name: "Report contents" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Engineering assessment" })).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "JSON", exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/report-\d+\.json/);
    const md = await page.request.get((await page.getByRole("link", { name: "Markdown" }).getAttribute("href")) ?? "");
    expect(md.headers()["content-type"]).toContain("text/markdown");
  });

  test("compare shows real differences between two analysed commits", async ({ page }) => {
    await benchWorkspace(page, "?view=compare");
    await expect(page.getByRole("button", { name: "svc/core/audit.py", exact: true }).first()).toBeVisible();
    await expect(page.getByText("svc/core/tokens.py").first()).toBeVisible();
    await expect(page.getByText("Potential impact", { exact: true })).toBeVisible();
  });

  test("assistant explains when the model is unavailable; panel toggles with the keyboard", async ({ page }) => {
    await benchWorkspace(page);
    const assistant = page.getByLabel("Investigation assistant");
    await expect(assistant.getByRole("status")).toContainText("The AI model is not available");
    await expect(page.getByRole("textbox", { name: "Question for the assistant" })).toBeDisabled();
    await page.keyboard.press("Control+i");
    await expect(page.getByRole("textbox", { name: "Question for the assistant" })).toBeHidden();
    await page.keyboard.press("Control+i");
    await expect(page.getByRole("textbox", { name: "Question for the assistant" })).toBeVisible();
  });

  test("unknown snapshot shows a recoverable error", async ({ page }) => {
    await login(page);
    await page.goto("/snapshots/999999");
    await expect(alert(page)).toContainText("snapshot not found");
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});

test.describe("assistant with a mocked agent API", () => {
  // OpenCode is disabled on the test backend. Only the agent and conversation endpoints are mocked here;
  // the evidence IDs are real ones from the seeded snapshot, so citation navigation runs against the backend.
  test("a contextual action asks about the selected symbol; the cited lines open from the answer", async ({ page }) => {
    const ids = await benchWorkspace(page, `?view=code&file=svc/core/auth.py`);
    const sid = ids["acme/bench"][0];
    const ev = await (await page.request.get(`/api/snapshots/${sid}/symbols?q=check_password&limit=1`)).json();
    const evidenceId = ev[0].evidence_id as string;
    let asked = "";
    const messages: unknown[] = [];
    await page.route("**/api/agent/status", (r) => r.fulfill({ json: { mode: "managed", available: true, version: "2.0.29", base_url: null, error: null, selected_model: "openai/gpt-5.6-terra", selected_model_available: true, agent_ready: true } }));
    await page.route("**/api/agent/models", (r) => r.fulfill({ json: [{ id: "openai/gpt-5.6-terra", name: "terra", family: null, enabled: true, context_limit: null }] }));
    await page.route(`**/api/snapshots/${sid}/conversations`, (r) =>
      r.request().method() === "POST"
        ? r.fulfill({ json: { id: 901, snapshot_id: sid, title: "New", model: "openai/gpt-5.6-terra", created_at: "", updated_at: "" } })
        : r.fulfill({ json: messages.length ? [{ id: 901, snapshot_id: sid, title: asked, model: "openai/gpt-5.6-terra", created_at: "", updated_at: "" }] : [] }),
    );
    await page.route("**/api/conversations/901/messages", async (r) => {
      asked = JSON.parse(r.request().postData() ?? "{}").content;
      messages.push(
        { id: 1, role: "user", content: asked, status: "complete", job_id: null, created_at: "", payload: {} },
        { id: 2, role: "assistant", content: "check_password validates the account and the password length.", status: "complete", job_id: null, created_at: "", payload: { grounding: "grounded", model: "openai/gpt-5.6-terra", claims: [{ statement: "check_password calls Account.validate", basis: "source_evidence", evidence_ids: [evidenceId], note: null }] } },
      );
      await r.fulfill({ json: { question_id: 1, reply_id: 2, job: { id: 1 } } });
    });
    await page.route("**/api/conversations/901", (r) => r.fulfill({ json: { id: 901, snapshot_id: sid, title: asked, model: "openai/gpt-5.6-terra", created_at: "", updated_at: "", messages } }));
    await page.reload();
    await page.getByRole("list", { name: "Symbols in this file" }).getByRole("button", { name: /^check_password/ }).click();
    await page.getByLabel("Investigation assistant").getByRole("button", { name: /Explain this/ }).click();
    await expect(page.getByText("check_password validates the account")).toBeVisible();
    expect(asked).toContain("check_password (svc/core/auth.py:");
    await expect(page.getByText("grounded in source")).toBeVisible();
    await page.getByLabel("Investigation assistant").locator("[data-evidence-id]").first().click();
    await expect(page).toHaveURL(/view=code&file=svc%2Fcore%2Fauth\.py&l=\d+-\d+/);
    expect(await seriousA11yViolations(page)).toEqual([]);
  });

  test("model selection in settings", async ({ page }) => {
    let selected = "openai/gpt-5.6-terra";
    await page.route("**/api/agent/status", (r) => r.fulfill({ json: { mode: "managed", available: true, version: "2.0.29", base_url: "http://127.0.0.1:47900", error: null, selected_model: selected, selected_model_available: true, agent_ready: true } }));
    await page.route("**/api/agent/models", (r) => r.fulfill({ json: [
      { id: "openai/gpt-5.6-terra", name: "GPT-5.6 Terra", family: null, enabled: true, context_limit: 400000 },
      { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", family: null, enabled: true, context_limit: 400000 },
    ] }));
    await page.route("**/api/agent/model", async (r) => {
      selected = JSON.parse(r.request().postData() ?? "{}").model;
      await r.fulfill({ json: { mode: "managed", available: true, version: "2.0.29", base_url: null, error: null, selected_model: selected, selected_model_available: true, agent_ready: true } });
    });
    await login(page);
    await page.goto("/settings");
    await expect(page.getByRole("row", { name: /openai\/gpt-5.6-terra/ })).toContainText("selected");
    await page.getByRole("button", { name: "Select openai/gpt-6.1-sol" }).click();
    await expect(page.getByRole("row", { name: /openai\/gpt-6.1-sol/ })).toContainText("selected");
  });
});

test.describe("responsive layout and reduced motion", () => {
  for (const vp of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 1024, height: 768 }]) {
    test(`no horizontal overflow at ${vp.width}x${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await login(page);
      const ids = await snapshots(page);
      for (const view of ["overview", "code&file=svc/core/auth.py", "architecture", "report"]) {
        await page.goto(`/snapshots/${ids["acme/bench"][0]}?view=${view}`);
        await page.waitForLoadState("networkidle");
        await noHorizontalOverflow(page);
        await page.screenshot({ path: `e2e/screenshots/${view.split("&")[0]}-${vp.width}x${vp.height}.png` });
      }
    });
  }

  test("reduced-motion preference disables animations and transitions", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await benchWorkspace(page);
    const timing = await page.evaluate(() => {
      const el = document.createElement("div");
      el.className = "animate-spin transition-colors";
      document.body.appendChild(el);
      const cs = getComputedStyle(el);
      return { animation: cs.animationDuration, transition: cs.transitionDuration, iterations: cs.animationIterationCount };
    });
    expect(timing).toEqual({ animation: "1e-06s", transition: "1e-06s", iterations: "1" });
  });
});
