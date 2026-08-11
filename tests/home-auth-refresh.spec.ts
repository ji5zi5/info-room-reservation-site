import { expect, test } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

test("home page does not crash when auth refresh receives an empty response", async ({ page }) => {
  await page.route("**/api/me", async (route) => {
    await route.fulfill({ body: "", status: 204 });
  });

  const firstPageError = page.waitForEvent("pageerror", { timeout: 1_000 }).catch(() => null);

  await page.goto(BASE_URL, { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { name: "예약 현황" })).toBeVisible();
  const pageError = await firstPageError;
  expect(pageError?.message ?? "").not.toContain("Unexpected end of JSON input");
});

test("login shows a failure message instead of crashing when the response body is empty", async ({ page }) => {
  await page.route("**/api/auth/riro/login", async (route) => {
    await route.fulfill({ body: "", status: 500 });
  });

  const firstPageError = page.waitForEvent("pageerror", { timeout: 1_000 }).catch(() => null);

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.getByLabel("리로스쿨 ID").fill("login-probe");
  await page.getByLabel("리로스쿨 PW").fill("password");
  await page.getByRole("button", { name: "인증하기" }).click();

  await expect(page.getByText("로그인에 실패했습니다.")).toBeVisible();
  const pageError = await firstPageError;
  expect(pageError?.message ?? "").not.toContain("Unexpected end of JSON input");
});

test("login recovers when the request fails before a response", async ({ page }) => {
  await page.route("**/api/auth/riro/login", async (route) => {
    await route.abort("failed");
  });

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.getByLabel("리로스쿨 ID").fill("login-probe");
  await page.getByLabel("리로스쿨 PW").fill("password");
  await page.getByRole("button", { name: "인증하기" }).click();

  await expect(page.getByText("네트워크 연결을 확인하고 다시 시도해주세요.")).toBeVisible();
  await expect(page.getByRole("button", { name: "인증하기" })).toBeEnabled();
});
