import { expect, test, type Locator, type Page } from "@playwright/test";

import { e2eNow, FIXED_FRIDAY_DATE, FIXED_THURSDAY_DATE, mockClientDate } from "./e2e-time";
import { visibleBox, visiblePosition } from "./playwright-layout";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

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
  await expectBorderRadius(statusPanel, "student reservation status panel", "4px");
  await expectBorderRadius(page.locator(".meter").first(), "reservation capacity meter", "4px");

  await advanceTab.click();
  await expect(todayTab).toHaveAttribute("data-active", "false");
  await expect(advanceTab).toHaveAttribute("data-active", "true");
  const datePicker = page.getByLabel("사전예약 날짜");
  await expect(datePicker).toBeVisible();
  await expect(datePicker).toHaveAttribute("min", FIXED_FRIDAY_DATE);
  await expect(datePicker).toHaveAttribute("max", FIXED_FRIDAY_DATE);
  await expect(page.getByRole("heading", { name: "이번 주 예약" })).toBeVisible();

  const datePickerBox = await visibleBox(datePicker, "advance date picker");
  const advancePeriodPosition = await visiblePosition(firstPeriodCard, "advance first period card");
  expect(datePickerBox.y).toBeLessThan(advancePeriodPosition.y);
  expect(Math.abs(Math.round(advancePeriodPosition.y - todayPeriodPosition.y))).toBeLessThanOrEqual(2);

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

  const topbar = page.locator(".tool-panel > .topbar");
  const topbarBox = await visibleBox(topbar, "reservation topbar");
  const topbarTextBox = await visibleBox(topbar.locator("> div").first(), "reservation topbar text");
  const calendarIcon = topbar.locator("> svg").first();

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
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth);
});

async function login(page: Page): Promise<void> {
  await page.getByLabel("리로스쿨 ID").fill("ui-density-student");
  await page.getByLabel("리로스쿨 PW").fill("password");
  await page.getByRole("button", { name: "인증하기" }).click();
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
}

async function mockAuth(page: Page): Promise<void> {
  await page.route("**/api/me", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { user: null } });
  });
  await page.route("**/api/auth/riro/login", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { user: mockUser } });
  });
  await page.route("**/api/csrf", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { csrfToken: "csrf-token" } });
  });
}

async function mockPeriods(page: Page): Promise<void> {
  await page.route("**/api/periods**", async (route) => {
    const url = new URL(route.request().url());
    const date = url.searchParams.get("date") ?? FIXED_THURSDAY_DATE;
    await route.fulfill({
      contentType: "application/json",
      json: {
        date,
        periods: [buildPeriod(date, "EIGHTH", "8면학"), buildPeriod(date, "FIRST", "1면학")],
      },
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
