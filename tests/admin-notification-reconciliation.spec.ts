import { expect, test, type Page } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const REVIEW_LABEL = "확인이 필요한 Discord 알림";
const UNKNOWN_ERROR = "Discord 응답을 받기 전에 연결이 종료되어 전송 결과를 확인할 수 없습니다.";

test.use({ viewport: { height: 844, width: 390 } });

test("notification reconciliation stays compact and readable on mobile", async ({ page }) => {
  const fixture = await mockReconciliationDashboard(page);

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  const adminHeading = page.getByRole("heading", { name: "관리자", exact: true });
  if (!(await adminHeading.isVisible())) {
    await page.getByLabel("리로스쿨 ID").fill("admin");
    await page.getByLabel("리로스쿨 PW").fill("password");
    await page.getByRole("button", { name: "인증하기", exact: true }).click();
  }
  await expect(adminHeading).toBeVisible();

  const review = page.getByRole("region", { name: REVIEW_LABEL });
  const rows = review.locator(".admin-notification-review-row");
  await expect(rows).toHaveCount(3);
  await expect(page.getByRole("heading", { name: "알림 확인 필요", exact: true })).toBeVisible();

  const longError = review.getByText(UNKNOWN_ERROR, { exact: true });
  await expect(longError).toHaveCSS("word-break", "keep-all");

  const unknownRow = rows.filter({ hasText: "7월 22일 · 8면학" });
  await expect(unknownRow).toHaveCount(1);
  const actions = unknownRow.locator(".admin-notification-review-actions");
  await expect(actions).toHaveCSS("display", "grid");
  expect((await actions.evaluate((element) => getComputedStyle(element).gridTemplateColumns)).split(" ")).toHaveLength(2);
  await expect(unknownRow.getByRole("button", { name: "전송됨 처리", exact: true })).toHaveCSS(
    "grid-column-end",
    "-1"
  );

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
  ).toBe(true);

  await unknownRow.getByRole("button", { name: "전송됨 처리", exact: true }).click();

  await expect(rows).toHaveCount(2);
  await expect(page.getByText("전송 완료로 처리했습니다.", { exact: true })).toBeVisible();
  expect(fixture.reconciliationRequests).toEqual([
    {
      action: "confirm_sent",
      date: "2026-07-22",
      studyPeriod: "EIGHTH"
    }
  ]);
});

async function mockReconciliationDashboard(page: Page): Promise<{
  readonly reconciliationRequests: Array<Record<string, unknown>>;
}> {
  const reconciliationRequests: Array<Record<string, unknown>> = [];
  let reconciled = false;

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        user: {
          bookingStatus: "ACTIVE",
          generation: 0,
          id: "mock-admin",
          name: "관리자",
          restrictionReason: null,
          restrictedUntil: null,
          role: "ADMIN",
          studentNumber: "0"
        }
      }
    });
  });
  await page.route("**/api/csrf", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { csrfToken: "test-csrf-token" } });
  });
  await page.route("**/api/auth/riro/login", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        user: {
          bookingStatus: "ACTIVE",
          generation: 0,
          id: "mock-admin",
          name: "관리자",
          restrictionReason: null,
          restrictedUntil: null,
          role: "ADMIN",
          studentNumber: "0"
        }
      }
    });
  });
  await page.route("**/api/admin/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    switch (pathname) {
      case "/api/admin/period-settings":
        await route.fulfill({ contentType: "application/json", json: { periods: periodSettings } });
        return;
      case "/api/admin/notification-settings":
        await route.fulfill({
          contentType: "application/json",
          json: {
            notificationSettings: {
              closedPeriodNotificationsEnabled: true,
              id: "global",
              reservationCreatedNotificationsEnabled: false
            }
          }
        });
        return;
      case "/api/admin/dashboard":
        await route.fulfill({
          contentType: "application/json",
          json: {
            notificationBacklog: reconciled ? notificationBacklog.slice(1) : notificationBacklog,
            periods: dashboardPeriods
          }
        });
        return;
      case "/api/admin/reservations":
        await route.fulfill({ contentType: "application/json", json: { reservations: [] } });
        return;
      case "/api/admin/statistics":
        await route.fulfill({ contentType: "application/json", json: { statistics } });
        return;
      case "/api/admin/users":
        await route.fulfill({ contentType: "application/json", json: { users: [] } });
        return;
      case "/api/admin/actions":
        await route.fulfill({ contentType: "application/json", json: { actions: [] } });
        return;
      case "/api/admin/notifications/closed-periods/reconcile":
        reconciliationRequests.push(route.request().postDataJSON() as Record<string, unknown>);
        reconciled = true;
        await route.fulfill({ contentType: "application/json", json: { ok: true } });
        return;
      default:
        await route.fulfill({
          contentType: "application/json",
          json: { error: { message: `Unexpected mocked route: ${pathname}` } },
          status: 404
        });
    }
  });

  return { reconciliationRequests };
}

const periodSettings = [
  {
    capacity: 10,
    closeTime: "16:20",
    confirmedCount: 8,
    date: "2026-07-23",
    enabled: true,
    label: "8면학",
    openTime: "13:00",
    remaining: 2,
    studyPeriod: "EIGHTH",
    windowState: "closed"
  },
  {
    capacity: 10,
    closeTime: "16:20",
    confirmedCount: 6,
    date: "2026-07-23",
    enabled: true,
    label: "1면학",
    openTime: "13:00",
    remaining: 4,
    studyPeriod: "FIRST",
    windowState: "closed"
  }
] as const;

const dashboardPeriods = periodSettings.map((period, index) => ({
  ...period,
  applicants: [],
  isClosed: true,
  notification: {
    attempts: index === 0 ? 1 : 3,
    failureCode: index === 0 ? "delivery_unknown" : "rate_limited",
    lastError: index === 0 ? "Discord 응답을 받기 전에 연결이 종료되었습니다." : "Discord 요청 제한",
    messageIds: [],
    nextAttemptAt: index === 0 ? null : "2026-07-23T07:30:00.000Z",
    sentAt: null,
    status: index === 0 ? "UNKNOWN" : "FAILED",
    updatedAt: "2026-07-22T07:25:00.000Z"
  }
}));

const notificationBacklog = [
  {
    attempts: 1,
    date: "2026-07-22",
    failureCode: "delivery_unknown",
    lastError: UNKNOWN_ERROR,
    nextAttemptAt: null,
    status: "UNKNOWN",
    studyPeriod: "EIGHTH",
    updatedAt: "2026-07-22T07:25:00.000Z"
  },
  {
    attempts: 3,
    date: "2026-07-21",
    failureCode: "rate_limited",
    lastError: "Discord 요청 제한으로 전송하지 못했습니다.",
    nextAttemptAt: "2026-07-23T07:30:00.000Z",
    status: "FAILED",
    studyPeriod: "FIRST",
    updatedAt: "2026-07-22T07:20:00.000Z"
  },
  {
    attempts: 0,
    date: "2026-07-20",
    failureCode: "prior_state_missing",
    lastError: "이전 실행의 전송 기록을 확인해야 합니다.",
    nextAttemptAt: null,
    status: "PENDING_REVIEW",
    studyPeriod: "EIGHTH",
    updatedAt: "2026-07-22T07:15:00.000Z"
  }
] as const;

const statistics = {
  dailyStats: [],
  from: "2026-07-23",
  periodStats: periodSettings.map((period) => ({
    cancelledCount: 0,
    capacity: period.capacity,
    confirmedCount: 0,
    fillRate: 0,
    label: period.label,
    noShowCount: 0,
    studyPeriod: period.studyPeriod,
    totalCount: 0
  })),
  repeatedOffenders: [],
  to: "2026-07-23",
  totals: {
    cancelledCount: 0,
    confirmedCount: 0,
    noShowCount: 0,
    totalCount: 0,
    uniqueStudentCount: 0
  }
};
