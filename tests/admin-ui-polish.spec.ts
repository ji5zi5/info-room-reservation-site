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

async function mockPeriodsForDate(page: Page, date: string): Promise<void> {
  await page.route(`**/api/periods?date=${date}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        periods: [
          buildMockPeriod(date, "EIGHTH", "8면학"),
          buildMockPeriod(date, "FIRST", "1면학")
        ]
      }),
      contentType: "application/json",
      status: 200
    });
  });
}

function buildMockPeriod(date: string, studyPeriod: "EIGHTH" | "FIRST", label: string): object {
  return {
    applicants: [],
    capacity: 10,
    closeTime: "23:59",
    confirmedCount: 0,
    date,
    enabled: true,
    label,
    myReservationId: null,
    openTime: "00:00",
    remaining: 10,
    studyPeriod,
    windowState: "open"
  };
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

test("admin panels keep concise headings and open student detail space only when selected", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await login(page, "admin");

  await expect(page.getByText("현황 · 명단 · 학생 제재 · 설정")).toHaveCount(0);
  await expect(page.getByText("신청 현황 · 마감 상태 · Discord 발송")).toHaveCount(0);
  await expect(page.locator(".student-detail-panel.empty-detail")).toHaveCount(0);
  await expect(page.locator(".admin-workspace")).toHaveAttribute("data-detail", "closed");
  const dashboardTracks = await page
    .locator(".admin-workspace")
    .evaluate((element) => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/u).length);
  expect(dashboardTracks).toBe(1);

  await page.getByRole("button", { name: "예약자" }).click();
  await expect(page.getByText("검색 · 노쇼 · 관리자 취소 · 명단 복사")).toHaveCount(0);
  await expect(page.locator(".student-detail-panel.empty-detail")).toHaveCount(0);

  await page.getByRole("button", { name: "설정" }).click();
  await expect(page.getByText("시간 설정 · 운영 현황 · 학생 관리")).toHaveCount(0);
  await expect(page.getByLabel("예약 날짜")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "로그아웃" })).toHaveCount(1);
  await expect(page.getByLabel("운영 날짜")).toBeVisible();
});

test("friday advance unavailable keeps the same content rail as today tab", async ({ page }) => {
  await mockPeriodsForDate(page, "2026-06-12");
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

test("mobile admin student detail flows below the list without clipping", async ({ page }) => {
  const loginId = `detail-mobile-${Date.now()}`;
  const studentNumber = loginId.replace(/\D/gu, "").slice(-5);
  await page.setViewportSize({ height: 900, width: 390 });
  await loginWithApi(page, loginId);
  await logout(page);
  await loginWithApi(page, "admin");
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "관리자" })).toBeVisible();
  await page.getByRole("button", { name: "학생" }).click();
  const studentRow = page.locator(".user-line").filter({ hasText: studentNumber }).first();
  await expect(studentRow).toBeVisible();
  await studentRow.getByRole("button", { name: "상세 보기" }).click();

  const detail = page.locator(".student-detail-panel[data-open='true']");
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("button", { name: "로그아웃 처리" })).toHaveCount(0);
  const metrics = await page.evaluate(() => {
    const detailElement = document.querySelector(".student-detail-panel[data-open='true']");
    const actions = document.querySelector(".student-detail-panel[data-open='true'] .detail-actions");
    const metricRow = document.querySelector(".student-detail-panel[data-open='true'] .detail-metrics");
    const mainPanel = document.querySelector(".admin-main-panel");
    return {
      actionsColumns: actions ? getComputedStyle(actions).gridTemplateColumns.split(" ").length : 0,
      detailClientHeight: detailElement?.clientHeight ?? 0,
      detailOverflowY: detailElement ? getComputedStyle(detailElement).overflowY : null,
      detailScrollHeight: detailElement?.scrollHeight ?? 0,
      detailTop: detailElement?.getBoundingClientRect().top ?? 0,
      mainPanelBottom: mainPanel?.getBoundingClientRect().bottom ?? 0,
      metricsColumns: metricRow ? getComputedStyle(metricRow).gridTemplateColumns.split(" ").length : 0,
      rootClientWidth: document.documentElement.clientWidth,
      rootScrollWidth: document.documentElement.scrollWidth
    };
  });

  expect(metrics.rootScrollWidth, "admin student detail should not create horizontal clipping").toBeLessThanOrEqual(metrics.rootClientWidth);
  expect(metrics.metricsColumns).toBe(3);
  expect(metrics.actionsColumns).toBe(0);
  expect(metrics.detailOverflowY, "student detail should use the page scroll on mobile").toBe("visible");
  expect(metrics.detailScrollHeight, "student detail should not hide lower controls inside an internal scrollbox").toBeLessThanOrEqual(
    metrics.detailClientHeight + 1
  );
  expect(metrics.detailTop, "student detail should sit below the student list on mobile").toBeGreaterThanOrEqual(
    metrics.mainPanelBottom - 1
  );
});

test("admin student management uses reason select and one restriction duration flow", async ({ page }) => {
  const loginId = `student-ux-${Date.now()}`;
  const studentNumber = loginId.replace(/\D/gu, "").slice(-5);
  let restrictionPayload: unknown = null;
  await page.route("**/api/admin/users/*/restriction", async (route) => {
    restrictionPayload = JSON.parse(route.request().postData() ?? "{}");
    await route.fulfill({ body: JSON.stringify({ user: null }), contentType: "application/json", status: 200 });
  });
  await loginWithApi(page, loginId);
  await logout(page);
  await loginWithApi(page, "admin");
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "관리자" })).toBeVisible();

  await page.getByRole("button", { name: "학생" }).click();
  await expect(page.locator(".user-line .restriction-controls")).toHaveCount(0);

  const studentRow = page.locator(".user-line").filter({ hasText: studentNumber }).first();
  await expect(studentRow).toBeVisible();
  await studentRow.getByRole("button", { name: "상세 보기" }).click();

  const detail = page.locator(".student-detail-panel[data-open='true']");
  await expect(detail).toBeVisible();
  const reasonInput = detail.getByLabel("제재 사유");
  await expect(reasonInput).toHaveValue("");
  await expect(detail.getByRole("button", { name: "예약 취소" })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "미출석" })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "관리자 확인" })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "기타" })).toHaveCount(0);

  await detail.getByLabel("사유 선택").selectOption("예약 취소");
  await expect(reasonInput).toHaveValue("예약 취소");
  await detail.getByLabel("사유 선택").selectOption("CUSTOM");
  await expect(reasonInput).toHaveValue("");
  await reasonInput.fill("직접 입력 사유");
  await expect(reasonInput).toHaveValue("직접 입력 사유");
  await expect(detail.getByLabel("기간", { exact: true })).toHaveCount(0);

  const duration = detail.getByRole("group", { name: "제재 기간" });
  await duration.getByRole("button", { name: "영구" }).click();
  await expect(duration.getByRole("button", { name: "영구" })).toHaveAttribute("data-active", "true");
  await detail.getByRole("button", { name: "제재 적용" }).click();
  await expect.poll(() => restrictionPayload).toEqual({
    days: null,
    reason: "직접 입력 사유",
    status: "BANNED"
  });
});
