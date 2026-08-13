import { expect, test, type Page, type Route } from "@playwright/test";
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
  await installRoutes(page, { notifications: fiveNotifications() });

  await login(page, "current-band-student");

  await expect(page.getByRole("button", { name: "내 정보 패널 열기" })).toBeVisible();
  const band = page.getByRole("region", { name: "현재 예약 상태" });
  await expect(band).toBeVisible();
  await expect(band.getByRole("button", { name: "2026-06-11 8면학 예약 보기" })).toBeVisible();
  await expect(band.getByRole("button", { name: "2026-06-12 1면학 예약 보기" })).toBeVisible();
  await expect(band.getByText("2026-06-08")).toHaveCount(0);

  const futureReservation = band.getByRole("button", { name: "2026-06-12 1면학 예약 보기" });
  await futureReservation.click();

  await expect(futureReservation).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".topbar .muted").first()).toHaveText(FIXED_FRIDAY);
  await expect(page.locator(".period-card").filter({ hasText: "1면학" }).getByRole("button", { name: "예약 취소" })).toBeVisible();
  await expect(page.locator(".period-card").filter({ hasText: "8면학" }).getByRole("button", { name: "예약 취소" })).toHaveCount(0);

  const bandBox = await visibleBox(band, "current reservation band");
  const calendarBox = await visibleBox(page.locator(".reservation-calendar"), "reservation calendar");
  expect(bandBox.y).toBeLessThan(calendarBox.y);
  expect(await hasHorizontalOverflow(page)).toBe(false);

  await page.screenshot({
    path: path.join(requiredEvidenceDir(), "task-18-current-reservations-mobile-390x844.png")
  });
});

test("student notification badge count matches five rendered rows and error state remains compact", async ({ page }) => {
  let notificationStatus: 200 | 500 = 200;
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockClientDate(page, e2eNow(FIXED_THURSDAY_DATE));
  await installRoutes(page, {
    getNotificationStatus: () => notificationStatus,
    notifications: fiveNotifications("매우 긴 한국어 사유가 줄바꿈되어도 패널 밖으로 밀려나지 않아야 합니다")
  });

  await login(page, "five-notification-student");

  const openButton = page.getByRole("button", { name: "학생 알림 열기" });
  await expect(openButton.locator(".student-notification-count")).toHaveText("5");
  await openButton.click();
  await expect(page.locator(".student-notification-item")).toHaveCount(5);
  await expect(page.getByText("알림 5")).toBeVisible();
  await expect(await hasHorizontalOverflow(page)).toBe(false);

  await page.screenshot({
    path: path.join(requiredEvidenceDir(), "task-18-notifications-desktop-1440x900.png")
  });

  notificationStatus = 500;
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await expect(page.locator(".period-card")).toHaveCount(2);
  await page.getByRole("button", { name: "학생 알림 열기" }).click();
  await expect(page.getByText("알림을 불러오지 못했습니다.")).toBeVisible();
  await expect(page.locator(".student-notification-item")).toHaveCount(0);
  await expect(await hasHorizontalOverflow(page)).toBe(false);
});

type MutableRouteOptions = RouteOptions & {
  readonly getNotificationStatus?: () => 200 | 500;
};

async function installRoutes(page: Page, options: MutableRouteOptions): Promise<void> {
  let currentUser: SessionUser | null = null;
  await page.route("**/api/me", (route) => route.fulfill({ json: { user: currentUser }, status: 200 }));
  await page.route("**/api/auth/riro/login", async (route) => {
    currentUser = studentUser();
    await route.fulfill({ json: { user: currentUser }, status: 200 });
  });
  await page.route("**/api/periods**", (route) => fulfillPeriods(route));
  await page.route("**/api/me/profile", (route) => route.fulfill({ json: profilePayload(currentUser ?? studentUser()), status: 200 }));
  await page.route("**/api/me/notifications", (route) => {
    if ((options.getNotificationStatus?.() ?? options.notificationStatus) === 500) {
      return route.fulfill({ json: { error: { message: "알림을 불러오지 못했습니다." } }, status: 500 });
    }
    return route.fulfill({ json: { notifications: options.notifications }, status: 200 });
  });
  await page.route("**/api/csrf", (route) => route.fulfill({ json: { csrfToken: "student-current-csrf" }, status: 200 }));
}

async function login(page: Page, id: string): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.getByLabel("리로스쿨 ID").fill(id);
  await page.getByLabel("리로스쿨 PW").fill("password");
  await page.getByRole("button", { name: "인증하기" }).click();
  await expect(page.locator(".period-card")).toHaveCount(2);
}

async function fulfillPeriods(route: Route): Promise<void> {
  const url = new URL(route.request().url());
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
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}

function requiredEvidenceDir(): string {
  const value = process.env.EVIDENCE_DIR;
  if (!value) {
    throw new Error("EVIDENCE_DIR is required for Todo 18 student screenshots.");
  }
  return value;
}
