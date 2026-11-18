import { expect, test } from "@playwright/test";
import { alert, login, noHorizontalOverflow, snapshots } from "./helpers";

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

  test("sidebar navigation, collapse persistence and command palette", async ({ page }) => {
    await login(page);
    await page.getByRole("link", { name: "Repositories", exact: true }).click();
    await expect(page.getByText("snapshot history").first()).toBeVisible();
    await page.getByRole("link", { name: "Recent analyses", exact: true }).click();
    await expect(page.getByRole("radiogroup", { name: "Filter jobs" })).toBeVisible();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByText("OpenCode runtime")).toBeVisible();
    await page.getByRole("button", { name: /Collapse sidebar/ }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: /Expand sidebar/ })).toBeVisible();
    await page.getByRole("button", { name: /Expand sidebar/ }).click();
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await page.getByLabel("Command palette search").fill("bench");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/snapshots\/\d+/);
  });
});

test.describe("dashboard & ingestion", () => {
  test("dashboard metrics and repository table come from real data", async ({ page }) => {
    await login(page);
    await expect(page.getByText("Repositories", { exact: true }).first()).toBeVisible();
    const row = page.getByRole("row", { name: /acme\/bench/ });
    await expect(row).toContainText("python");
    await expect(row).toContainText("files");
    await noHorizontalOverflow(page);
  });

  test("URL validation, submission and job failure state", async ({ page }) => {
    await login(page);
    const input = page.getByLabel("GitHub repository URL");
    await input.fill("https://gitlab.com/a/b");
    await expect(page.getByText("Only github.com repositories are supported")).toBeVisible();
    await expect(page.getByRole("button", { name: /Analyze/ })).toBeDisabled();
    await input.fill("https://github.com/acme/does-not-exist-e2e");
    await expect(page.getByText(/Ready to analyse/)).toBeVisible();
    await page.getByRole("button", { name: /Analyze/ }).click();
    await expect(page).toHaveURL(/\/jobs\/\d+/);
    // The test backend only allows file:// remotes, so the real clone attempt fails: the UI must show it.
    await expect(alert(page)).toContainText("acquisition_failed", { timeout: 45_000 });
    await expect(page.getByRole("progressbar")).toBeVisible();
  });
});

test.describe("workspace", () => {
  test("overview renders deterministic findings and citations open exact source lines", async ({ page }) => {
    await login(page);
    const ids = await snapshots(page);
    await page.goto(`/snapshots/${ids["acme/bench"][0]}`);
    await expect(page.getByText("What this repository does")).toBeVisible();
    await expect(page.getByText("README states", { exact: false })).toBeVisible();
    await expect(page.getByText("POST /login").first()).toBeVisible();
    const chip = page.locator("[data-evidence-id]").first();
    await expect(chip).not.toContainText(/^ev_/);
    await chip.click();
    await expect(page).toHaveURL(/view=code/);
    await expect(page.locator("[data-highlighted]").first()).toBeVisible();
  });

  test("code explorer: tree filter, source viewer, outline and references", async ({ page }) => {
    await login(page);
    const ids = await snapshots(page);
    await page.goto(`/snapshots/${ids["acme/bench"][0]}?view=code`);
    await page.keyboard.press("/");
    await page.getByLabel("Filter files").fill("auth.py");
    await page.getByRole("button", { name: "svc/core/auth.py" }).click();
    const source = page.getByTestId("source-view");
    await expect(source).toContainText("def login(name: str, password: str)");
    await page.getByRole("button", { name: /^login function$/ }).click();
    await expect(page.locator("[data-highlighted]").first()).toBeVisible();
    await expect(page.getByText("Direct references")).toBeVisible();
    await expect(page.getByRole("button", { name: /login_route/ }).first()).toBeVisible();
    await expect(page.getByText("Related routes")).toBeVisible();
  });

  test("architecture graph, inspector, focus and execution flow", async ({ page }) => {
    await login(page);
    const ids = await snapshots(page);
    await page.goto(`/snapshots/${ids["acme/bench"][0]}?view=architecture&gview=calls`);
    const nodes = page.locator(".react-flow__node");
    await expect(nodes.first()).toBeVisible();
    expect(await nodes.count()).toBeGreaterThan(5);
    await page.locator(".react-flow__node", { hasText: "issue_token" }).first().click();
    await expect(page.getByText("Direct references").first()).toBeVisible();
    await page.getByRole("radio", { name: "Impact" }).click();
    await expect(page.getByText("Potential impact from static reachability")).toBeVisible();
    await page.getByLabel("Find and focus a node").fill("Account.validate");
    await page.getByRole("button", { name: "Focus" }).first().click();
    await expect(page).toHaveURL(/gview=focus/);
    await page.getByRole("radio", { name: "Flows" }).click();
    await page.getByRole("button", { name: /POST \/login/ }).click();
    const steps = page.getByRole("list", { name: "Flow steps" });
    await expect(steps).toContainText("issue_token");
    await expect(steps).toContainText("sign");
    await expect(page.getByText("not observed runtime order")).toBeVisible();
  });

  test("report renders with TOC, sections and exports", async ({ page }) => {
    await login(page);
    const ids = await snapshots(page);
    await page.goto(`/snapshots/${ids["acme/sample"][0]}?view=report`);
    await expect(page.getByRole("navigation", { name: "Report contents" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Engineering assessment" })).toBeVisible();
    await page.getByRole("button", { name: "Engineering assessment" }).click();
    await expect(page.getByRole("button", { name: "Engineering assessment" })).toHaveAttribute("aria-expanded", "false");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "JSON", exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/report-\d+\.json/);
    const md = await page.request.get((await page.getByRole("link", { name: "Markdown" }).getAttribute("href")) ?? "");
    expect(md.headers()["content-type"]).toContain("text/markdown");
  });

  test("compare shows real differences between two analysed commits", async ({ page }) => {
    await login(page);
    const ids = await snapshots(page);
    await page.goto(`/snapshots/${ids["acme/bench"][0]}?view=compare`);
    await expect(page.getByRole("button", { name: "svc/core/audit.py", exact: true }).first()).toBeVisible();
    await expect(page.getByText("svc/core/tokens.py").first()).toBeVisible();
    await expect(page.getByText("Potential impact", { exact: true })).toBeVisible();
  });

  test("investigation shows the agent-unavailable state without breaking", async ({ page }) => {
    await login(page);
    const ids = await snapshots(page);
    await page.goto(`/snapshots/${ids["acme/bench"][0]}?view=investigate`);
    await expect(page.getByRole("status").filter({ hasText: "Agent unavailable" })).toBeVisible();
    await page.getByRole("button", { name: "New investigation" }).first().click();
    await expect(page.getByRole("textbox", { name: "Question" })).toBeDisabled();
  });

  test("unknown snapshot shows a recoverable error", async ({ page }) => {
    await login(page);
    await page.goto("/snapshots/999999");
    await expect(alert(page)).toContainText("snapshot not found");
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});

test.describe("agent UI with mocked agent API", () => {
  // OpenCode is disabled on the test backend; these responses are explicit mocks of the agent endpoints only.
  test("model selection flow", async ({ page }) => {
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

test.describe("responsive layout", () => {
  for (const vp of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 1024, height: 768 }]) {
    test(`no horizontal overflow at ${vp.width}x${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await login(page);
      const ids = await snapshots(page);
      for (const view of ["overview", "code", "architecture", "report"]) {
        await page.goto(`/snapshots/${ids["acme/bench"][0]}?view=${view}`);
        await page.waitForLoadState("networkidle");
        await noHorizontalOverflow(page);
        await page.screenshot({ path: `e2e/screenshots/${view}-${vp.width}x${vp.height}.png` });
      }
    });
  }
});
