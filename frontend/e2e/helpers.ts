import { type Locator, type Page, expect } from "@playwright/test";
import { E2E_TOKEN } from "./constants";

export async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("API token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: undefined }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
}

/** Snapshot ids of the seeded repositories, via the API (same session cookie). */
export async function snapshots(page: Page): Promise<Record<string, number[]>> {
  const res = await page.request.get("/api/repositories");
  expect(res.ok()).toBeTruthy();
  const repos = (await res.json()) as { owner: string; name: string; snapshots: { id: number }[]; current_snapshot_id: number }[];
  return Object.fromEntries(repos.map((r) => [`${r.owner}/${r.name}`, [r.current_snapshot_id, ...r.snapshots.map((s) => s.id).filter((id) => id !== r.current_snapshot_id)]]));
}

export async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

/** Application alerts (excludes Next.js's always-present route announcer, which also has role="alert"). */
export function alert(page: Page): Locator {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}
