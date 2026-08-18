import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import path from "node:path";

import type { StudentNotification } from "../src/lib/student-notifications";
import type { StudentPeriodSummary, StudentPeriodWeekPeriod } from "../src/lib/student-period-summary";
import type { StudentProfilePayload } from "../src/lib/student-profile";
import { e2eNow, FIXED_THURSDAY_DATE, mockClientDate } from "./e2e-time";
import { visibleBox } from "./playwright-layout";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const FIXED_FRIDAY = "2026-06-12";
const SCHOOL_WEEK_DATES = ["2026-06-08", "2026-06-09", "2026-06-10", FIXED_THURSDAY_DATE, FIXED_FRIDAY] as const;

type SessionUser = {
  readonly bookingStatus: "ACTIVE";
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly restrictionReason: null;
  readonly restrictedUntil: null;
  readonly role: "STUDENT";
  readonly studentNumber: string;
};

type RouteOptions = {
  readonly notificationStatus?: 200 | 500;
  readonly notifications: readonly StudentNotification[];
};

test("current reservation band stays visible with collapsed sidebar and navigates exact date and period", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockClientDate(page, e2eNow(FIXED_THURSDAY_DATE));
  const fixture = await installRoutes(page, { notifications: fiveNotifications() });

  await login(page, "current-band-student");

  await expect(page.getByRole("button", { name: "내 정보 패널 열기" })).toBeVisible();
  const band = page.getByRole("region", { name: "현재 예약 상태" });
  await expect(band).toBeVisible();
  await expect(band.getByRole("button", { name: "2026-06-11 8면학 예약 보기" })).toBeVisible();
  await expect(band.getByRole("button", { name: "2026-06-12 1면학 예약 보기" })).toBeVisible();
  await expect(band.getByText("2026-06-08")).toHaveCount(0);

  const futureReservation = band.getByRole("button", { name: "2026-06-12 1면학 예약 보기" });
  await futureReservation.click();

  await expectSelectedReservationContrast(futureReservation);
  await expect(futureReservation).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".topbar .muted").first()).toHaveText(FIXED_FRIDAY);
  await expect(page.locator(".period-card").filter({ hasText: "1면학" }).getByRole("button", { name: "예약 취소" })).toBeVisible();
  await expect(page.locator(".period-card").filter({ hasText: "8면학" }).getByRole("button", { name: "예약 취소" })).toHaveCount(0);
  expect(fixture.periodRequests.some((request) => request.searchParams.get("weekStart") === "2026-06-08")).toBe(true);

  const bandBox = await visibleBox(band, "current reservation band");
  const calendarBox = await visibleBox(page.locator(".reservation-calendar"), "reservation calendar");
  expect(bandBox.y).toBeLessThan(calendarBox.y);
  expect(await hasHorizontalOverflow(page)).toBe(false);

  await page.screenshot({
    path: path.join(requiredEvidenceDir(), "task-18-current-reservations-mobile-390x844.png")
  });
});

test("desktop current reservation band has one working control per reservation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockClientDate(page, e2eNow(FIXED_THURSDAY_DATE));
  await installRoutes(page, { notifications: fiveNotifications() });

  await login(page, "current-band-desktop-student");

  const todayReservation = page.getByRole("button", { name: "2026-06-11 8면학 예약 보기", exact: true });
  const futureReservation = page.getByRole("button", { name: "2026-06-12 1면학 예약 보기", exact: true });
  await expect(todayReservation).toHaveCount(1);
  await expect(futureReservation).toHaveCount(1);

  await futureReservation.click();

  await expectSelectedReservationContrast(futureReservation);
  await expect(futureReservation).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".topbar .muted").first()).toHaveText(FIXED_FRIDAY);
  await expect(page.locator(".period-card").filter({ hasText: "1면학" }).getByRole("button", { name: "예약 취소" })).toBeVisible();

  await page.screenshot({
    path: path.join(requiredEvidenceDir(), "task-18-current-reservations-desktop-1440x900.png")
  });
  await page.screenshot({
    path: path.join(requiredEvidenceDir(), "task-18-selected-nav-desktop-1440x900.png")
  });
});

test("desktop-expanded five-row notification popover preserves workflow geometry", async ({ page }) => {
  let notificationStatus: 200 | 500 = 200;
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockClientDate(page, e2eNow(FIXED_THURSDAY_DATE));
  await installRoutes(page, {
    getNotificationStatus: () => notificationStatus,
    notifications: fiveNotifications("매우 긴 한국어 사유가 줄바꿈되어도 패널 밖으로 밀려나지 않아야 합니다")
  });

  await login(page, "five-notification-student");

  const flowBefore = await capturePopoverFlow(page);
  const openButton = page.getByRole("button", { name: "학생 알림 열기" });
  await expect(openButton.locator(".student-notification-count")).toHaveText("5");
  await openButton.click();
  const notificationWidget = page.locator(".student-notification-widget");
  await expect(notificationWidget).toHaveAttribute("data-open", "true");
  await expect(page.getByRole("button", { name: "학생 알림 닫기" })).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".student-notification-item")).toHaveCount(5);
  await expect(page.getByText("알림 5")).toBeVisible();
  await expectPopoverFlowUnchanged(page, flowBefore);
  await expectWithinViewport(page.locator(".student-notification-body"), page, "desktop expanded notification popover");
  await expect(await hasHorizontalOverflow(page)).toBe(false);

  await page.screenshot({
    path: path.join(requiredEvidenceDir(), "task-18-notifications-desktop-expanded-1440x900.png")
  });

  await page.keyboard.press("Escape");
  await expect(openButton).toHaveAttribute("aria-expanded", "false");
  await expect(openButton).toBeFocused();

  notificationStatus = 500;
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await expect(page.locator(".period-card")).toHaveCount(2);
  await page.getByRole("button", { name: "학생 알림 열기" }).click();
  await expect(page.getByText("알림을 불러오지 못했습니다.")).toBeVisible();
  await expect(page.locator(".student-notification-item")).toHaveCount(0);
  await expect(await hasHorizontalOverflow(page)).toBe(false);
});

test("mobile-expanded long Korean notification popover preserves workflow geometry", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockClientDate(page, e2eNow(FIXED_THURSDAY_DATE));
  await installRoutes(page, {
    notifications: fiveNotifications("매우 긴 한국어 사유가 좁은 모바일 화면에서도 잘려나가지 않고 자연스럽게 줄바꿈되어야 합니다".repeat(2))
  });

  await login(page, "five-notification-mobile-student");

  const flowBefore = await capturePopoverFlow(page);
  const openButton = page.getByRole("button", { name: "학생 알림 열기" });
  await expect(openButton.locator(".student-notification-count")).toHaveText("5");
  await openButton.click();

  const notificationWidget = page.locator(".student-notification-widget");
  await expect(notificationWidget).toHaveAttribute("data-open", "true");
  await expect(page.locator(".student-notification-item")).toHaveCount(5);
  await expectNotificationDetailsToFit(page.locator(".student-notification-body"));
  await expectPopoverFlowUnchanged(page, flowBefore);
  await expectWithinViewport(page.locator(".student-notification-body"), page, "mobile expanded notification popover");
  await expect(await hasHorizontalOverflow(page)).toBe(false);

  await page.screenshot({
    path: path.join(requiredEvidenceDir(), "task-18-notifications-mobile-expanded-long-korean-390x844.png")
  });
});

type MutableRouteOptions = RouteOptions & {
  readonly getNotificationStatus?: () => 200 | 500;
};

type StudentRouteFixture = {
  readonly periodRequests: readonly URL[];
};

async function installRoutes(page: Page, options: MutableRouteOptions): Promise<StudentRouteFixture> {
  const periodRequests: URL[] = [];
  let currentUser: SessionUser | null = null;
  await page.route("**/api/me", (route) => route.fulfill({ json: { user: currentUser }, status: 200 }));
  await page.route("**/api/auth/riro/login", async (route) => {
    currentUser = studentUser();
    await route.fulfill({ json: { user: currentUser }, status: 200 });
  });
  await page.route("**/api/periods**", (route) => fulfillPeriods(route, periodRequests));
  await page.route("**/api/me/profile", (route) => route.fulfill({ json: profilePayload(currentUser ?? studentUser()), status: 200 }));
  await page.route("**/api/me/notifications", (route) => {
    if ((options.getNotificationStatus?.() ?? options.notificationStatus) === 500) {
      return route.fulfill({ json: { error: { message: "알림을 불러오지 못했습니다." } }, status: 500 });
    }
    return route.fulfill({ json: { notifications: options.notifications }, status: 200 });
  });
  await page.route("**/api/csrf", (route) => route.fulfill({ json: { csrfToken: "student-current-csrf" }, status: 200 }));
  return { periodRequests };
}

async function login(page: Page, id: string): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.getByLabel("리로스쿨 ID").fill(id);
  await page.getByLabel("리로스쿨 PW").fill("password");
  await page.getByRole("button", { name: "인증하기" }).click();
  await expect(page.locator(".period-card")).toHaveCount(2);
}

async function fulfillPeriods(route: Route, periodRequests: URL[]): Promise<void> {
  const url = new URL(route.request().url());
  periodRequests.push(url);
  if (url.searchParams.has("weekStart")) {
    await route.fulfill({
      headers: { ETag: '"task-18-current-reservations"' },
      json: {
        dates: SCHOOL_WEEK_DATES.map((date) => ({
          date,
          periods: [weekPeriod(date, "EIGHTH"), weekPeriod(date, "FIRST")]
        }))
      },
      status: 200
    });
    return;
  }
  const date = url.searchParams.get("date") ?? FIXED_THURSDAY_DATE;
  await route.fulfill({
    json: {
      periods: [datePeriod(date, "EIGHTH", "8면학"), datePeriod(date, "FIRST", "1면학")]
    },
    status: 200
  });
}

function weekPeriod(date: string, studyPeriod: "EIGHTH" | "FIRST"): StudentPeriodWeekPeriod {
  const reservationId = reservationIdFor(date, studyPeriod);
  return {
    availability: reservationId ? 9 : 10,
    capacity: 10,
    closeTime: "23:59",
    enabled: true,
    myReservationId: reservationId,
    openTime: "00:00",
    reservedCount: reservationId ? 1 : 0,
    studyPeriod
  };
}

function datePeriod(date: string, studyPeriod: "EIGHTH" | "FIRST", label: "8면학" | "1면학"): StudentPeriodSummary {
  const reservationId = reservationIdFor(date, studyPeriod);
  return {
    capacity: 10,
    closeTime: "23:59",
    confirmedCount: reservationId ? 1 : 0,
    date,
    enabled: true,
    label,
    myReservationId: reservationId,
    openTime: "00:00",
    remaining: reservationId ? 9 : 10,
    studyPeriod,
    windowState: "open"
  };
}

function reservationIdFor(date: string, studyPeriod: "EIGHTH" | "FIRST"): string | null {
  if (date === FIXED_THURSDAY_DATE && studyPeriod === "EIGHTH") {
    return "reservation-today-eighth";
  }
  if (date === FIXED_FRIDAY && studyPeriod === "FIRST") {
    return "reservation-future-first";
  }
  if (date === "2026-06-08" && studyPeriod === "EIGHTH") {
    return "reservation-past-eighth";
  }
  return null;
}

function fiveNotifications(reason = "관리자 조정"): readonly StudentNotification[] {
  return Array.from({ length: 5 }, (_, index) => ({
    createdAt: `2026-06-11T0${index}:00:00.000Z`,
    id: `notification-${index}`,
    message: `2026-06-${12 - index} ${index % 2 === 0 ? "8면학" : "1면학"} 신청이 취소되었습니다.`,
    reason,
    title: `알림 ${index + 1}`
  }));
}

function studentUser(): SessionUser {
  return {
    bookingStatus: "ACTIVE",
    generation: 18,
    id: "task-18-student",
    name: "긴한국어이름학생",
    restrictionReason: null,
    restrictedUntil: null,
    role: "STUDENT",
    studentNumber: "32018"
  };
}

function profilePayload(user: SessionUser): StudentProfilePayload {
  return {
    currentReservations: [],
    effectiveStatus: "ACTIVE",
    recentReservations: [],
    recentSanctions: [],
    reservationSummary: { cancelledCount: 0, confirmedCount: 0, noShowCount: 0 },
    sanctionSummary: { activeCount: 0, permanentCount: 0, revokedCount: 0, totalCount: 0 },
    statusMessage: "예약 가능",
    user
  };
}

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth ||
      document.body.scrollWidth > document.body.clientWidth
  );
}

type PopoverFlow = {
  readonly modeRow: Awaited<ReturnType<typeof visibleBox>>;
  readonly topbar: Awaited<ReturnType<typeof visibleBox>>;
};

async function capturePopoverFlow(page: Page): Promise<PopoverFlow> {
  return {
    modeRow: await visibleBox(page.locator(".reservation-mode-row"), "reservation mode row"),
    topbar: await visibleBox(page.locator(".tool-panel > .topbar"), "reservation topbar")
  };
}

async function expectPopoverFlowUnchanged(page: Page, before: PopoverFlow): Promise<void> {
  const after = await capturePopoverFlow(page);
  expect(Math.abs(after.topbar.height - before.topbar.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.modeRow.y - before.modeRow.y)).toBeLessThanOrEqual(1);
}

async function expectWithinViewport(locator: Locator, page: Page, label: string): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error("viewport should be configured");
  }
  const box = await visibleBox(locator, label);
  expect(box.x, `${label} left edge`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${label} top edge`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${label} right edge`).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height, `${label} bottom edge`).toBeLessThanOrEqual(viewport.height);
}

async function expectSelectedReservationContrast(locator: Locator): Promise<void> {
  const colors = await locator.evaluate((element) => {
    const selectedLabel = element.querySelector("strong");
    if (selectedLabel === null) {
      throw new Error("selected reservation label should exist");
    }
    const buttonStyles = window.getComputedStyle(element);
    const labelStyles = window.getComputedStyle(selectedLabel);
    return {
      backgroundColor: buttonStyles.backgroundColor,
      buttonColor: buttonStyles.color,
      labelColor: labelStyles.color
    };
  });
  expect(contrastRatio(colors.buttonColor, colors.backgroundColor)).toBeGreaterThanOrEqual(7);
  expect(contrastRatio(colors.labelColor, colors.backgroundColor)).toBeGreaterThanOrEqual(7);
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function relativeLuminance(color: string): number {
  const matches = color.match(/\d+(?:\.\d+)?/gu);
  if (matches === null || matches.length < 3) {
    throw new Error(`Expected an RGB computed color, received ${color}`);
  }
  const channels = matches.slice(0, 3).map((match) => Number(match) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  if (red === undefined || green === undefined || blue === undefined) {
    throw new Error("Expected three RGB channels");
  }
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

async function expectNotificationDetailsToFit(body: Locator): Promise<void> {
  await expect(body).toHaveCSS("overflow-y", "auto");
  const dimensions = await body.locator(".student-notification-item p").evaluateAll((elements) =>
    elements.map((element) => ({
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth
    }))
  );
  expect(dimensions).toHaveLength(10);
  expect(dimensions.every((dimension) => dimension.scrollHeight <= dimension.clientHeight + 1)).toBe(true);
  expect(dimensions.every((dimension) => dimension.scrollWidth <= dimension.clientWidth)).toBe(true);
}

function requiredEvidenceDir(): string {
  const value = process.env.EVIDENCE_DIR;
  if (!value) {
    throw new Error("EVIDENCE_DIR is required for Todo 18 student screenshots.");
  }
  return value;
}
