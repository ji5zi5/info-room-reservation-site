import { expect, test, type Page } from "@playwright/test";

import { e2eNow, FIXED_FRIDAY_DATE, FIXED_THURSDAY_DATE, mockClientDate } from "./e2e-time";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

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

test("weekly reservation calendar shows status and jumps between advance and today", async ({ page }) => {
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

  await expect(page.getByRole("heading", { name: "이번 주 예약" })).toBeVisible();
  await expect(page.getByText("사전예약 06.12")).toBeVisible();

  const friday = page.locator(".calendar-day").filter({ hasText: "06.12" });
  await expect(friday.getByText("내 예약")).toBeVisible();
  await expect(friday.getByText("8면학 예약됨")).toBeVisible();

  await friday.click();
  await expect(page.getByRole("button", { name: "사전예약" })).toHaveAttribute("data-active", "true");
  await expect(page.getByLabel("사전예약 날짜")).toHaveValue(FIXED_FRIDAY_DATE);

  await page.getByRole("button", { name: "오늘 예약" }).click();
  await expect(page.getByRole("button", { name: "당일예약" })).toHaveAttribute("data-active", "true");
});

test("weekly reservation calendar keeps Friday advance closure visible", async ({ page }) => {
  await mockPeriods(page, {
    [FIXED_FRIDAY_DATE]: [
      period({ label: "8면학", studyPeriod: "EIGHTH" }),
      period({ label: "1면학", studyPeriod: "FIRST" })
    ]
  });
  await login(page, `calendar-friday-${Date.now()}`, e2eNow(FIXED_FRIDAY_DATE));

  await expect(page.getByRole("heading", { name: "이번 주 예약" })).toBeVisible();
  await expect(page.getByText("금요일 이후 사전예약 불가")).toBeVisible();
  await expect(page.locator(".calendar-day[data-advance='true']")).toHaveCount(0);
});

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
    const date = url.searchParams.get("date") ?? FIXED_THURSDAY_DATE;
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
