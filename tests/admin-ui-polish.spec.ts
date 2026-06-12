import { expect, test, type Page } from "@playwright/test";

import { csrfRequest } from "./playwright-csrf";
import { visibleBox } from "./playwright-layout";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

async function login(page: Page, loginId: string): Promise<void> {
  if (loginId === "admin") {
    await loginWithApi(page, loginId);
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "관리자" })).toBeVisible();
    return;
  }
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.locator("input").nth(0).fill(loginId);
  await page.locator("input").nth(1).fill("password");
  await page.getByRole("button", { name: "인증하기" }).click();
  await page.locator(".period-card .period-badge").first().waitFor();
}

async function logout(page: Page): Promise<void> {
  await csrfRequest(page, "/api/auth/logout", { method: "POST" });
}

async function loginWithApi(page: Page, loginId: string): Promise<void> {
  const response = await page.request.post(`${BASE_URL}/api/auth/riro/login`, {
    data: { id: loginId, password: "password" },
    headers: { "x-forwarded-for": `192.0.2.${Math.floor(Math.random() * 200) + 1}` }
  });
  expect(response.ok()).toBeTruthy();
}

async function mockClientDate(page: Page, fixedIso: string): Promise<void> {
  await page.addInitScript((iso) => {
    const fixedNow = new Date(iso).valueOf();
    const RealDate = Date;
    class MockDate extends RealDate {
      public constructor(value?: string | number | Date) {
        super(value ?? fixedNow);
      }

      public static override now(): number {
        return fixedNow;
      }
    }
    globalThis.Date = MockDate as DateConstructor;
  }, fixedIso);
}

test("admin student management keeps empty detail from clipping the 390px viewport", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 390 });
  await login(page, "admin");
  await page.getByRole("button", { name: "학생" }).click();
  await expect(page.getByRole("heading", { name: "학생 관리" })).toBeVisible();

  await expect(page.locator(".student-detail-panel.empty-detail")).toBeHidden();
  const metrics = await page.evaluate(() => ({
    rootClientWidth: document.documentElement.clientWidth,
    rootScrollWidth: document.documentElement.scrollWidth
  }));
  expect(metrics.rootScrollWidth, "student admin view should not have horizontal clipping").toBeLessThanOrEqual(metrics.rootClientWidth);
});

test("friday advance unavailable keeps the same content rail as today tab", async ({ page }) => {
  await mockClientDate(page, "2026-06-12T09:00:00+09:00");
  await login(page, `friday-rail-${Date.now()}`);

  const todayCard = page.locator(".period-card").first();
  const todayBox = await visibleBox(todayCard, "today period card");
  await page.getByRole("button", { name: "사전예약" }).click();

  const unavailable = page.getByRole("status").filter({ hasText: "사전예약 불가" });
  await expect(unavailable).toBeVisible();
  const unavailableBox = await visibleBox(unavailable, "advance unavailable panel");
  expect(Math.abs(Math.round(unavailableBox.y - todayBox.y))).toBeLessThanOrEqual(2);
});

test("left panel exposes smooth width and content transitions", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await login(page, `motion-${Date.now()}`);

  const panel = page.locator(".login-panel");
  const content = page.locator(".sidebar-content");
  const openBox = await visibleBox(panel, "open sidebar");
  await page.getByRole("button", { name: "왼쪽 패널 접기" }).click();
  await expect(page.getByRole("button", { name: "왼쪽 패널 열기" })).toBeVisible();

  const closedDisplay = await content.evaluate((element) => getComputedStyle(element).display);
  const closedTransition = await content.evaluate((element) => getComputedStyle(element).transitionProperty);
  await expect.poll(async () => Math.round((await visibleBox(panel, "closed sidebar")).width)).toBe(72);
  const closedBox = await visibleBox(panel, "closed sidebar");
  const toggleBox = await visibleBox(page.getByRole("button", { name: "왼쪽 패널 열기" }), "closed sidebar toggle");

  expect(closedBox.height, "closing should keep a stable panel surface").toBeGreaterThan(70);
  expect(closedBox.y).toBe(openBox.y);
  expect(Math.round(closedBox.width)).toBe(72);
  expect(Math.abs(Math.round(toggleBox.x + toggleBox.width / 2 - (closedBox.x + closedBox.width / 2)))).toBeLessThanOrEqual(1);
  expect(closedDisplay, "sidebar content must remain renderable so opacity/transform can animate").not.toBe("none");
  expect(closedTransition).toContain("opacity");
  expect(closedTransition).toContain("transform");
});

test("mobile left panel collapses to a reopen button and expands again", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 390 });
  await login(page, `mobile-fold-${Date.now()}`);

  await page.getByRole("button", { name: "왼쪽 패널 접기" }).click();
  await expect(page.getByRole("button", { name: "왼쪽 패널 열기" })).toBeVisible();
  await expect.poll(async () => Math.round((await visibleBox(page.locator(".login-panel"), "closed mobile panel")).height)).toBeLessThanOrEqual(80);

  await page.getByRole("button", { name: "왼쪽 패널 열기" }).click();
  await expect(page.getByRole("button", { name: "왼쪽 패널 접기" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "정보실 예약" })).toBeVisible();
});

test("mobile admin student detail stays compact without horizontal clipping", async ({ page }) => {
  const loginId = `detail-mobile-${Date.now()}`;
  await page.setViewportSize({ height: 900, width: 390 });
  await loginWithApi(page, loginId);
  await logout(page);
  await loginWithApi(page, "admin");
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "관리자" })).toBeVisible();
  await page.getByRole("button", { name: "학생" }).click();
  await expect(page.getByRole("button", { name: "자세히" }).first()).toBeVisible();
  await page.getByRole("button", { name: "자세히" }).first().click();

  const detail = page.locator(".student-detail-panel[data-open='true']");
  await expect(detail).toBeVisible();
  const metrics = await page.evaluate(() => {
    const detailElement = document.querySelector(".student-detail-panel[data-open='true']");
    const actions = document.querySelector(".student-detail-panel[data-open='true'] .detail-actions");
    const metricRow = document.querySelector(".student-detail-panel[data-open='true'] .detail-metrics");
    return {
      actionsColumns: actions ? getComputedStyle(actions).gridTemplateColumns.split(" ").length : 0,
      detailHeight: detailElement?.getBoundingClientRect().height ?? 0,
      metricsColumns: metricRow ? getComputedStyle(metricRow).gridTemplateColumns.split(" ").length : 0,
      rootClientWidth: document.documentElement.clientWidth,
      rootScrollWidth: document.documentElement.scrollWidth
    };
  });

  expect(metrics.rootScrollWidth, "admin student detail should not create horizontal clipping").toBeLessThanOrEqual(metrics.rootClientWidth);
  expect(metrics.metricsColumns).toBe(3);
  expect(metrics.actionsColumns).toBe(2);
  expect(metrics.detailHeight, "student detail should stay visually compact on mobile").toBeLessThan(820);
});
