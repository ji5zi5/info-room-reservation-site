import { expect, test, type Locator, type Page } from "@playwright/test";

import { e2eNow, FIXED_FRIDAY_DATE, FIXED_THURSDAY_DATE, mockClientDate } from "./e2e-time";
import { visibleBox, visiblePosition } from "./playwright-layout";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SCHOOL_WEEK_DATES = ["2026-06-08", "2026-06-09", "2026-06-10", FIXED_THURSDAY_DATE, FIXED_FRIDAY_DATE] as const;

const mockUser = {
  bookingStatus: "ACTIVE",
  generation: 25,
  id: "student-ui-density",
  name: "감자칩",
  restrictionReason: null,
  restrictedUntil: null,
  role: "STUDENT",
  studentNumber: "25-00000",
};

test("student reservation controls keep date selection compact", async ({ page }) => {
  await mockClientDate(page, e2eNow(FIXED_THURSDAY_DATE));
  await mockAuth(page);
  await mockPeriods(page);

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await login(page);

  const firstPeriodCard = page.locator(".period-card").first();
  const todayPeriodPosition = await visiblePosition(firstPeriodCard, "today first period card");
  const todayTab = page.getByRole("button", { name: "당일예약" });
  const advanceTab = page.getByRole("button", { name: "사전예약" });
  const todayTabBox = await visibleBox(todayTab, "today tab");
  const advanceTabBox = await visibleBox(advanceTab, "advance tab");

  const tabbarHeight = await visibleHeight(page.locator(".tabbar"), "reservation mode tabs");
  expect(tabbarHeight).toBeLessThanOrEqual(60);
  await expectBorderRadius(page.locator(".tabbar"), "reservation mode tabs", "4px");
  expect(Math.round(todayTabBox.width)).toBe(Math.round(advanceTabBox.width));
  expect(Math.round(todayTabBox.height)).toBe(Math.round(advanceTabBox.height));
  await expect(page.getByLabel("예약 날짜")).toHaveCount(0);

  const statusPanel = page.getByLabel("내 예약 상태");
  await expect(statusPanel).toBeVisible();
  await expect(statusPanel.getByText("취소 가능 여부")).toHaveCount(0);
  await expect(statusPanel.getByText("문의 코드")).toHaveCount(0);

  const statusPanelHeight = await visibleHeight(statusPanel, "student reservation status panel");
  expect(statusPanelHeight).toBeLessThanOrEqual(145);
  await expect(statusPanel.locator(".student-status-summary span")).toHaveText("예약 가능 시점");
  await expectBorderRadius(statusPanel, "student reservation status panel", "4px");
  await expectBorderRadius(page.locator(".meter").first(), "reservation capacity meter", "4px");

  await advanceTab.click();
  await expect(todayTab).toHaveAttribute("data-active", "false");
  await expect(advanceTab).toHaveAttribute("data-active", "true");
  await expect(page.locator('input[type="date"]')).toHaveCount(0);
  const calendar = page.locator(".reservation-calendar");
  await expect(calendar).toBeVisible();
  await expect(page.getByRole("heading", { name: "이번 주" })).toBeVisible();

  const calendarBox = await visibleBox(calendar, "advance calendar");
  const calendarHeight = await visibleHeight(calendar, "advance calendar");
  const advancePeriodPosition = await visiblePosition(firstPeriodCard, "advance first period card");
  expect(calendarBox.y).toBeLessThan(advancePeriodPosition.y);
  expect(calendarHeight).toBeLessThanOrEqual(150);

  await todayTab.click();
  await expect(todayTab).toHaveAttribute("data-active", "true");
  await expect(advanceTab).toHaveAttribute("data-active", "false");
  const todayAgainPeriodPosition = await visiblePosition(firstPeriodCard, "today first period card after return");
  expect(Math.abs(Math.round(todayAgainPeriodPosition.y - todayPeriodPosition.y))).toBeLessThanOrEqual(2);
});

test("student reservation mobile topbar avoids icon-only rows and horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockClientDate(page, e2eNow(FIXED_THURSDAY_DATE));
  await mockAuth(page);
  await mockPeriods(page);

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await login(page);
  await expect(page.getByRole("button", { name: "내 정보 패널 열기" })).toBeVisible();
  await expect(page.locator(".login-panel[data-open='false'] .brand-mark")).toBeVisible();
  await expect(page.locator(".login-panel[data-open='false'] .sidebar-toggle-label")).toHaveText("내 정보");
  await expect
    .poll(async () => Math.round((await visibleBox(page.locator(".login-panel"), "collapsed mobile login panel")).height))
    .toBeLessThanOrEqual(80);

  const topbar = page.locator(".tool-panel > .topbar");
  const topbarBox = await visibleBox(topbar, "reservation topbar");
  const topbarTextBox = await visibleBox(topbar.locator("> div").first(), "reservation topbar text");
  const calendarIcon = topbar.locator("> svg").first();
  const firstPeriodCard = page.locator(".period-card").first();
  const firstPeriodCardBox = await visibleBox(firstPeriodCard, "mobile first period card");
  const calendarBox = await visibleBox(page.locator(".reservation-calendar"), "mobile reservation calendar");
  const calendarGrid = page.locator(".calendar-grid");
  const calendarGridBox = await visibleBox(calendarGrid, "mobile calendar date strip");

  if (await calendarIcon.isVisible()) {
    const iconBox = await visibleBox(calendarIcon, "reservation topbar calendar icon");
    expect(Math.round(topbarBox.height)).toBeLessThanOrEqual(
      Math.ceil(Math.max(topbarTextBox.height, iconBox.height)) + 2
    );
  }

  const overflow = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth
  }));
  expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth);
  expect(overflow.bodyWidth).toBe(overflow.viewportWidth);
  expect(firstPeriodCardBox.y, "first reservation card should be reachable on the first mobile screen").toBeLessThanOrEqual(760);
  expect(calendarBox.y, "mobile calendar should stay above reservation cards").toBeLessThan(firstPeriodCardBox.y);
  expect(calendarGridBox.height, "mobile calendar dates should fit in one compact strip").toBeLessThanOrEqual(120);
  expect(await visibleHeight(page.locator(".reservation-warning"), "reservation rule strip")).toBeLessThanOrEqual(64);
  await expect(page.locator(".reservation-warning")).toContainText("예약 규칙");

  await expect(page.locator(".applicant-toggle")).toHaveCount(0);
});

test("student notification panel opens and closes all counted notifications", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockClientDate(page, e2eNow(FIXED_THURSDAY_DATE));
  await mockAuth(page);
  await mockPeriods(page);
  await mockNotifications(page);

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await login(page);

  const openButton = page.getByRole("button", { name: "학생 알림 열기" });
  await expect(openButton).toBeVisible();
  await expect(openButton.locator(".student-notification-count")).toHaveText("5");
  await expect(page.getByText("관리자 취소 안내")).toBeHidden();

  await openButton.click();

  const closeButton = page.getByRole("button", { name: "학생 알림 닫기" });
  await expect(closeButton).toBeVisible();
  await expect(page.locator(".student-notification-item")).toHaveCount(5);
  await expect(page.getByText("관리자 취소 안내")).toHaveCount(5);
  await expect(page.getByText("2026-06-12 8면학 신청이 취소되었습니다.")).toBeVisible();

  await closeButton.click();

  await expect(page.getByRole("button", { name: "학생 알림 열기" })).toBeVisible();
  await expect(page.getByText("관리자 취소 안내")).toBeHidden();
});

async function login(page: Page): Promise<void> {
  await page.getByLabel("리로스쿨 ID").fill("ui-density-student");
  await page.getByLabel("리로스쿨 PW").fill("password");
  await page.getByRole("button", { name: "인증하기" }).click();
  await expect(page.locator(".period-card .period-badge").first()).toBeVisible();
}

async function mockAuth(page: Page): Promise<void> {
  let currentUser: typeof mockUser | null = null;
  await page.route("**/api/me", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { user: currentUser } });
  });
  await page.route("**/api/auth/riro/login", async (route) => {
    currentUser = mockUser;
    await route.fulfill({ contentType: "application/json", json: { user: mockUser } });
  });
  await page.route("**/api/csrf", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { csrfToken: "csrf-token" } });
  });
}

async function mockPeriods(page: Page): Promise<void> {
  await page.route("**/api/periods**", async (route) => {
    const url = new URL(route.request().url());
    const weekStart = url.searchParams.get("weekStart");
    const date = url.searchParams.get("date") ?? FIXED_THURSDAY_DATE;
    if (weekStart) {
      await route.fulfill({
        contentType: "application/json",
        json: {
          dates: SCHOOL_WEEK_DATES.map((weekDate) => ({
            date: weekDate,
            periods: [buildWeekPeriod("EIGHTH"), buildWeekPeriod("FIRST")]
          }))
        }
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: {
        date,
        periods: [buildPeriod(date, "EIGHTH", "8면학"), buildPeriod(date, "FIRST", "1면학")],
      },
    });
  });
}

function buildWeekPeriod(studyPeriod: "EIGHTH" | "FIRST") {
  return {
    availability: 10,
    capacity: 10,
    closeTime: "21:00",
    enabled: true,
    myReservationId: null,
    openTime: "20:00",
    reservedCount: 0,
    studyPeriod
  };
}

async function mockNotifications(page: Page): Promise<void> {
  await page.route("**/api/me/notifications", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        notifications: [
          ...Array.from({ length: 5 }, (_, index) => ({
            createdAt: `2026-06-11T0${index}:00:00.000Z`,
            id: `notification-${index}`,
            message: `2026-06-${12 - index} ${index % 2 === 0 ? "8면학" : "1면학"} 신청이 취소되었습니다.`,
            reason: "관리자 조정",
            title: "관리자 취소 안내"
          }))
        ]
      }
    });
  });
}

function buildPeriod(date: string, studyPeriod: "EIGHTH" | "FIRST", label: "8면학" | "1면학") {
  return {
    applicants: [],
    capacity: 10,
    closeTime: "21:00",
    confirmedCount: 0,
    date,
    enabled: true,
    label,
    myReservationId: null,
    openTime: "20:00",
    remaining: 10,
    studyPeriod,
    windowState: "open" as const,
  };
}

async function visibleHeight(locator: Locator, label: string): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error(`${label} should be visible`);
  }
  return box.height;
}

async function expectBorderRadius(locator: Locator, label: string, expectedRadius: string): Promise<void> {
  const radius = await locator.evaluate((element) => {
    const view = element.ownerDocument.defaultView;
    if (view === null) {
      throw new Error("document view should exist");
    }
    return view.getComputedStyle(element).borderRadius;
  });
  expect.soft(radius, `${label} border radius`).toBe(expectedRadius);
}
