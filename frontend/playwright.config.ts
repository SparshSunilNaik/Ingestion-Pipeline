import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { E2E_TOKEN } from "./e2e/constants";

// End-to-end tests run against a REAL backend (separate test data dir, test-only token, seeded from
// tests/fixtures) and a real Next.js server. OpenCode is disabled; agent-dependent UI paths that need a
// model use explicitly mocked API responses inside the individual tests.
const BACKEND_PORT = 8765;
const FRONTEND_PORT = 3100;
const DATA_DIR = path.join(__dirname, "e2e", ".data");
const UV = (process.env.IP_UV_CMD ?? "uv").split(" ");
// Fresh, isolated data for every run (evaluated before the web servers start).
// Playwright re-evaluates this file in worker processes (TEST_WORKER_INDEX set) while servers run: only wipe in the main process.
if (!process.env.PW_KEEP_DATA && !process.env.TEST_WORKER_INDEX) fs.rmSync(DATA_DIR, { recursive: true, force: true });

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: `http://127.0.0.1:${FRONTEND_PORT}`,
    viewport: { width: 1600, height: 900 },
    trace: "retain-on-failure",
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 900 }, ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) } }],
  webServer: [
    {
      command: [...UV, "run", "python", "-m", "uvicorn", "app.main:app_factory", "--factory", "--host", "127.0.0.1", "--port", String(BACKEND_PORT)].join(" "),
      cwd: path.join(__dirname, "..", "backend"),
      url: `http://127.0.0.1:${BACKEND_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        IP_ENVIRONMENT: "test",
        IP_DATA_DIR: DATA_DIR,
        IP_API_TOKEN: E2E_TOKEN,
        IP_WORKER_MODE: "inprocess",
        IP_OPENCODE_MODE: "disabled",
        IP_GIT_ALLOWED_PROTOCOLS: "file",
        IP_LOG_LEVEL: "WARNING",
        UV_LINK_MODE: "copy",
      },
    },
    {
      // Production build in its own dist dir: tests the real output and coexists with a running dev server.
      command: `npx next build && npx next start --port ${FRONTEND_PORT}`,
      url: `http://127.0.0.1:${FRONTEND_PORT}/login`,
      reuseExistingServer: false,
      timeout: 400_000,
      env: { IP_BACKEND_URL: `http://127.0.0.1:${BACKEND_PORT}`, NEXT_DIST_DIR: ".next-e2e", NEXT_TELEMETRY_DISABLED: "1" },
    },
  ],
});
