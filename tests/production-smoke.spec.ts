import { expect, test, type Page } from "@playwright/test";

const BASE_URL = requiredEnv("E2E_BASE_URL");
const ADMIN_LOGIN_ID = requiredEnv("E2E_ADMIN_LOGIN_ID");
const ADMIN_LOGIN_PASSWORD = requiredEnv("E2E_ADMIN_LOGIN_PASSWORD");
const STUDENT_LOGIN_ID = requiredEnv("E2E_STUDENT_LOGIN_ID");
const STUDENT_LOGIN_PASSWORD = requiredEnv("E2E_STUDENT_LOGIN_PASSWORD");

test("critical student and administrator surfaces load on the isolated app", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      runtimeErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    runtimeErrors.push(error.message);
  });

  const liveResponse = await page.request.get(`${BASE_URL}/api/health/live`);
  expect(liveResponse.status()).toBe(200);
  await expect(liveResponse.json()).resolves.toMatchObject({ status: "ok" });

  await login(page, STUDENT_LOGIN_ID, STUDENT_LOGIN_PASSWORD, "198.51.100.31");
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await expect(page.locator(".period-card").first()).toBeVisible();

  await page.context().clearCookies();
  await login(page, ADMIN_LOGIN_ID, ADMIN_LOGIN_PASSWORD, "198.51.100.32");
  await page.goto(`${BASE_URL}/admin`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "관리자" })).toBeVisible();
  await expect(page.locator("main")).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

async function login(
  page: Page,
  id: string,
  password: string,
  clientIp: string
): Promise<void> {
  const response = await page.request.post(`${BASE_URL}/api/auth/riro/login`, {
    data: { id, password },
    headers: { "x-forwarded-for": clientIp }
  });
  if (!response.ok()) {
    throw new Error(`Smoke login failed with ${response.status()}: ${await response.text()}`);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the production smoke test.`);
  }
  return value;
}
