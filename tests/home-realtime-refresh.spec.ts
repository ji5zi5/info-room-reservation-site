import { expect, test, type Page } from "@playwright/test";

import { e2eNow, FIXED_FRIDAY_DATE, FIXED_THURSDAY_DATE, mockClientDate } from "./e2e-time";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

type StudyPeriod = "EIGHTH" | "FIRST";

test("returning to the tab refreshes seat counts and updates the last refresh time", async ({ page }) => {
  let full = false;
  await mockPeriodRoutes(page, () => full);
  await login(page, `visible-refresh-${Date.now()}`);

  await expect(page.locator(".period-refresh-time").first()).toContainText("마지막 갱신:");
  await expect(page.locator(".period-card").filter({ hasText: "8면학" }).getByRole("button", { name: "8면학 예약" })).toBeVisible();

  full = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await expect(page.locator(".period-card").filter({ hasText: "8면학" }).getByRole("button", { name: "마감" })).toBeVisible();
});

test("background refresh shows progress without removing current period cards", async ({ page }) => {
  let refreshGate: Promise<void> | null = null;
  let releaseRefresh = (): void => {};
  await mockPeriodRoutes(
    page,
    () => false,
    () => false,
    async () => {
      if (refreshGate) {
        await refreshGate;
      }
    }
  );
  await login(page, `refresh-progress-${Date.now()}`);

  refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await expect(page.locator(".refresh-status")).toContainText("갱신 중");
  await expect(page.locator(".period-card")).toHaveCount(2);
  await expect(
    page.locator(".period-card").filter({ hasText: "8면학" }).getByRole("button", { name: "8면학 예약" })
  ).toBeVisible();

  releaseRefresh();
  refreshGate = null;
  await expect(page.locator(".refresh-status")).not.toContainText("갱신 중");
});

test("failed background refresh keeps the last visible period status", async ({ page }) => {
  let failRefresh = false;
  await mockPeriodRoutes(page, () => false, () => failRefresh);
  await login(page, `failed-refresh-${Date.now()}`);

  failRefresh = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await expect(page.locator(".period-card")).toHaveCount(2);
  await expect(
    page.locator(".period-card").filter({ hasText: "8면학" }).getByRole("button", { name: "8면학 예약" })
  ).toBeVisible();
});

test("reservation click rechecks the server before opening the confirmation dialog", async ({ page }) => {
  let full = false;
  await mockPeriodRoutes(page, () => full);
  await login(page, `preflight-${Date.now()}`);

  const eighthCard = page.locator(".period-card").filter({ hasText: "8면학" });
  await expect(eighthCard.getByRole("button", { name: "8면학 예약" })).toBeVisible();

  full = true;
  await eighthCard.getByRole("button", { name: "8면학 예약" }).click();

  await expect(page.getByRole("dialog", { name: "8면학 예약할까요?" })).toHaveCount(0);
  await expect(page.getByText("최신 좌석 수를 반영했습니다. 다시 확인하세요.")).toBeVisible();
  await expect(eighthCard.getByRole("button", { name: "마감" })).toBeVisible();
});

async function login(page: Page, loginId: string): Promise<void> {
  await mockClientDate(page, e2eNow(FIXED_THURSDAY_DATE));
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.locator("input").nth(0).fill(loginId);
  await page.locator("input").nth(1).fill("password");
  await page.getByRole("button", { name: "인증하기" }).click();
  await page.locator(".period-card .period-badge").first().waitFor();
}

async function mockPeriodRoutes(
  page: Page,
  isFull: () => boolean,
  shouldFail: () => boolean = () => false,
  beforeFulfill: () => Promise<void> = () => Promise.resolve()
): Promise<void> {
  await page.route("**/api/periods**", async (route) => {
    const date = new URL(route.request().url()).searchParams.get("date") ?? FIXED_THURSDAY_DATE;
    await beforeFulfill();
    if (shouldFail()) {
      await route.fulfill({
        body: JSON.stringify({ error: { message: "refresh failed" } }),
        contentType: "application/json",
        status: 500
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        periods: [
          period({
            date,
            label: "8면학",
            remaining: date === FIXED_THURSDAY_DATE && isFull() ? 0 : 1,
            studyPeriod: "EIGHTH"
          }),
          period({ date, label: "1면학", remaining: 4, studyPeriod: "FIRST" })
        ]
      }),
      contentType: "application/json",
      status: 200
    });
  });
}

function period(input: {
  readonly date: string;
  readonly label: string;
  readonly remaining: number;
  readonly studyPeriod: StudyPeriod;
}) {
  return {
    applicants: [],
    capacity: 10,
    closeTime: "23:59",
    confirmedCount: 10 - input.remaining,
    date: input.date,
    enabled: true,
    label: input.label,
    myReservationId: null,
    openTime: "00:00",
    remaining: input.remaining,
    studyPeriod: input.studyPeriod,
    windowState: "open"
  };
}
