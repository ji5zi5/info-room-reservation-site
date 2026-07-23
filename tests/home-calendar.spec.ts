import { errors, expect, test, type Page } from "@playwright/test";

import { e2eNow, FIXED_FRIDAY_DATE, FIXED_THURSDAY_DATE, mockClientDate } from "./e2e-time";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const FIXED_WEDNESDAY_DATE = "2026-06-10";
const NEXT_WEEK_MONDAY_DATE = "2026-06-15";
const SCHOOL_WEEK_DATES = ["2026-06-08", "2026-06-09", FIXED_WEDNESDAY_DATE, FIXED_THURSDAY_DATE, FIXED_FRIDAY_DATE] as const;

type StudyPeriod = "EIGHTH" | "FIRST";
type WindowState = "closed" | "not_open_yet" | "open";

type MockUser = {
  readonly bookingStatus: "ACTIVE";
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly restrictionReason: null;
  readonly restrictedUntil: null;
  readonly role: "STUDENT";
  readonly studentNumber: string;
};

type MockPeriodInput = {
  readonly enabled?: boolean;
  readonly label: string;
  readonly myReservationId?: string | null;
  readonly remaining?: number;
  readonly studyPeriod: StudyPeriod;
  readonly windowState?: WindowState;
};

test("weekly reservation calendar keeps date tiles focused on selection", async ({ page }) => {
  await mockPeriods(page, {
    [FIXED_THURSDAY_DATE]: [
      period({ label: "8면학", studyPeriod: "EIGHTH" }),
      period({ label: "1면학", studyPeriod: "FIRST" })
    ],
    [FIXED_FRIDAY_DATE]: [
      period({ label: "8면학", myReservationId: "mine-eighth", studyPeriod: "EIGHTH" }),
      period({ label: "1면학", remaining: 0, studyPeriod: "FIRST", windowState: "closed" })
    ]
  });
  await login(page, `calendar-${Date.now()}`);

  await expect(page.getByRole("heading", { name: "이번 주" })).toBeVisible();
  await expect(page.getByText(/^사전예약 \d{2}\.\d{2}/u)).toHaveCount(0);

  const calendar = page.locator(".reservation-calendar");
  await expect(calendar.getByText(/내 예약|예약 가능|불가|지난 날짜|오픈 전/u)).toHaveCount(0);

  const monday = page.locator(".calendar-day").filter({ hasText: "06.08" });
  await expect(monday).toBeDisabled();
  await expect(monday).toHaveAccessibleName(/지난 날짜/u);
  await expect(monday).toHaveCSS("background-color", "rgb(238, 238, 238)");
  await expect(monday.locator("strong")).toHaveCSS("color", "rgb(142, 142, 142)");

  const friday = page.locator(".calendar-day").filter({ hasText: "06.12" });
  await expect(friday).toBeEnabled();
  await expect(friday).toHaveAccessibleName(/현황 확인 가능/u);
  await expect(friday.getByText("선택")).toHaveCount(0);

  await friday.click();
  await expect(page.getByRole("button", { name: "사전예약" })).toHaveAttribute("data-active", "true");
  await expect(page.locator(".topbar .muted").first()).toHaveText(FIXED_FRIDAY_DATE);
  await expect(friday.locator(".calendar-day-marker")).toHaveCSS("background-color", "rgb(255, 255, 255)");

  await expect(page.getByRole("button", { name: "오늘 예약" })).toHaveCount(0);
  await page.locator(".tabbar button").first().click();
  await expect(page.getByRole("button", { name: "당일예약" })).toHaveAttribute("data-active", "true");
});

test("weekly reservation calendar keeps full advance dates enterable for cancellation refreshes", async ({ page }) => {
  await mockPeriods(page, {
    [FIXED_FRIDAY_DATE]: [
      period({ label: "8면학", remaining: 0, studyPeriod: "EIGHTH" }),
      period({ label: "1면학", remaining: 0, studyPeriod: "FIRST" })
    ]
  });
  await login(page, `calendar-full-${Date.now()}`);

  const friday = page.locator(".calendar-day").filter({ hasText: "06.12" });
  await expect(friday).toBeEnabled();

  await friday.click();

  await expect(page.getByRole("button", { name: "사전예약" })).toHaveAttribute("data-active", "true");
  await expect(page.locator(".topbar .muted").first()).toHaveText(FIXED_FRIDAY_DATE);
  await expect(page.locator(".period-button").filter({ hasText: "마감" })).toHaveCount(2);
});

test("weekly reservation calendar keeps date selection on the visible tiles only", async ({ page }) => {
  await mockPeriods(page, {
    [FIXED_FRIDAY_DATE]: [
      period({ label: "8면학", studyPeriod: "EIGHTH" }),
      period({ label: "1면학", studyPeriod: "FIRST" })
    ],
    [FIXED_WEDNESDAY_DATE]: [
      period({ label: "8면학", studyPeriod: "EIGHTH" }),
      period({ label: "1면학", studyPeriod: "FIRST" })
    ],
    [NEXT_WEEK_MONDAY_DATE]: [
      period({ label: "8면학", studyPeriod: "EIGHTH" }),
      period({ label: "1면학", studyPeriod: "FIRST" })
    ]
  });
  const invalidPreviousDateRequest = waitForPeriodRequestOutcome(page, FIXED_WEDNESDAY_DATE);
  const invalidNextWeekRequest = waitForPeriodRequestOutcome(page, NEXT_WEEK_MONDAY_DATE);
  await login(page, `calendar-input-removed-${Date.now()}`);

  await page.locator(".tabbar button").nth(1).click();

  await expect(page.locator('input[type="date"]')).toHaveCount(0);
  await expect(page.locator(".topbar .muted").first()).toHaveText(FIXED_FRIDAY_DATE);
  expect(await invalidPreviousDateRequest).toBe("not-requested");
  expect(await invalidNextWeekRequest).toBe("not-requested");
});

test("weekly reservation calendar keeps Friday advance closure state without policy copy", async ({ page }) => {
  await mockPeriods(page, {
    [FIXED_FRIDAY_DATE]: [
      period({ label: "8면학", studyPeriod: "EIGHTH" }),
      period({ label: "1면학", studyPeriod: "FIRST" })
    ]
  });
  await login(page, `calendar-friday-${Date.now()}`, e2eNow(FIXED_FRIDAY_DATE));

  await expect(page.getByRole("heading", { name: "이번 주" })).toBeVisible();
  await expect(page.getByText("금요일 이후 사전예약 불가")).toHaveCount(0);
  await expect(page.locator(".calendar-day[data-advance='true']")).toHaveCount(0);
});

async function waitForPeriodRequestOutcome(page: Page, date: string): Promise<"not-requested" | "requested"> {
  try {
    await page.waitForRequest(
      (request) => {
        const url = new URL(request.url());
        return url.pathname === "/api/periods" && url.searchParams.get("date") === date;
      },
      { timeout: 500 }
    );
    return "requested";
  } catch (error: unknown) {
    if (error instanceof errors.TimeoutError) {
      return "not-requested";
    }
    throw error;
  }
}

async function login(page: Page, loginId: string, fixedIso = e2eNow(FIXED_THURSDAY_DATE)): Promise<void> {
  await mockAuth(page, loginId);
  await mockClientDate(page, fixedIso);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.locator("input").nth(0).fill(loginId);
  await page.locator("input").nth(1).fill("password");
  await page.getByRole("button", { name: "인증하기" }).click();
  await page.locator(".period-card .period-badge").first().waitFor();
}

async function mockPeriods(
  page: Page,
  periodsByDate: Readonly<Record<string, readonly ReturnType<typeof period>[]>>
): Promise<void> {
  await page.route("**/api/periods**", async (route) => {
    const url = new URL(route.request().url());
    const weekStart = url.searchParams.get("weekStart");
    const date = url.searchParams.get("date") ?? FIXED_THURSDAY_DATE;
    if (weekStart) {
      await route.fulfill({
        body: JSON.stringify({
          dates: SCHOOL_WEEK_DATES.map((weekDate) => ({
            date: weekDate,
            periods: (periodsByDate[weekDate] ?? [
              period({ label: "8면학", studyPeriod: "EIGHTH" }),
              period({ label: "1면학", studyPeriod: "FIRST" })
            ]).map(toWeekPeriod)
          }))
        }),
        contentType: "application/json",
        status: 200
      });
      return;
    }
    const periods = periodsByDate[date] ?? [
      period({ label: "8면학", studyPeriod: "EIGHTH" }),
      period({ label: "1면학", studyPeriod: "FIRST" })
    ];
    await route.fulfill({
      body: JSON.stringify({ periods: periods.map((mockPeriod) => ({ ...mockPeriod, date })) }),
      contentType: "application/json",
      status: 200
    });
  });
}

function toWeekPeriod(mockPeriod: ReturnType<typeof period>): object {
  return {
    availability: mockPeriod.remaining,
    capacity: mockPeriod.capacity,
    closeTime: mockPeriod.closeTime,
    enabled: mockPeriod.enabled,
    myReservationId: mockPeriod.myReservationId,
    openTime: mockPeriod.openTime,
    reservedCount: mockPeriod.confirmedCount,
    studyPeriod: mockPeriod.studyPeriod
  };
}

async function mockAuth(page: Page, loginId: string): Promise<void> {
  await page.route("**/api/me", async (route) => {
    await route.fulfill({ body: JSON.stringify({ user: null }), contentType: "application/json", status: 200 });
  });
  await page.route("**/api/auth/riro/login", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ user: buildMockUser(loginId) }),
      contentType: "application/json",
      status: 200
    });
  });
}

function buildMockUser(loginId: string): MockUser {
  return {
    bookingStatus: "ACTIVE",
    generation: 31,
    id: loginId,
    name: "테스트학생",
    restrictionReason: null,
    restrictedUntil: null,
    role: "STUDENT",
    studentNumber: "31-12345"
  };
}

function period(input: MockPeriodInput) {
  const remaining = input.remaining ?? 10;
  return {
    applicants: [],
    capacity: 10,
    closeTime: "23:59",
    confirmedCount: 10 - remaining,
    date: "",
    enabled: input.enabled ?? true,
    label: input.label,
    myReservationId: input.myReservationId ?? null,
    openTime: "00:00",
    remaining,
    studyPeriod: input.studyPeriod,
    windowState: input.windowState ?? "open"
  };
}
