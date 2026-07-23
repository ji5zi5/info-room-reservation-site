import { expect, test, type Page } from "@playwright/test";

import { e2eNow, FIXED_FRIDAY_DATE, FIXED_THURSDAY_DATE, mockClientDate } from "./e2e-time";

declare global {
  interface Window {
    __drainTrackedFetches: () => readonly string[];
    __minuteIntervalCount: () => number;
    __runMinuteIntervals: () => void;
  }
}

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SCHOOL_WEEK_DATES = [
  "2026-06-08",
  "2026-06-09",
  "2026-06-10",
  FIXED_THURSDAY_DATE,
  FIXED_FRIDAY_DATE
] as const;

type StudyPeriod = "EIGHTH" | "FIRST";
type PeriodRequestKind = "date" | "week";
type PollingRequestCounts = {
  date: number;
  notifications: number;
  week: number;
};
type MockSessionUser = {
  readonly bookingStatus: "ACTIVE";
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly restrictedUntil: null;
  readonly restrictionReason: null;
  readonly role: "STUDENT";
  readonly studentNumber: string;
};

test("student polling loads one weekly summary and one notification request", async ({ page }) => {
  const counts: PollingRequestCounts = { date: 0, notifications: 0, week: 0 };
  await mockPeriodRoutes(page, () => false, () => false, () => Promise.resolve(), (kind) => {
    counts[kind] += 1;
  });
  await mockNotificationRoute(page, () => {
    counts.notifications += 1;
  });

  await login(page, `polling-initial-${Date.now()}`);

  await expect.poll(() => counts).toEqual({ date: 0, notifications: 1, week: 1 });
});

test("student polling makes one weekly and one notification request per visible minute", async ({ page }) => {
  const counts: PollingRequestCounts = { date: 0, notifications: 0, week: 0 };
  await installMinuteIntervalController(page);
  await mockPeriodRoutes(page, () => false, () => false, () => Promise.resolve(), (kind) => {
    counts[kind] += 1;
  });
  await mockNotificationRoute(page, () => {
    counts.notifications += 1;
  });
  await login(page, `polling-visible-${Date.now()}`);
  await expect.poll(() => counts.date + counts.week + counts.notifications).toBeGreaterThan(0);
  await expect.poll(() => minuteIntervalCount(page)).toBe(2);
  await drainTrackedFetches(page);

  await runMinuteIntervals(page, "visible");

  expect(pollingCounts(await drainTrackedFetches(page))).toEqual({ date: 0, notifications: 1, week: 1 });
});

test("student polling makes no requests while the document is hidden", async ({ page }) => {
  const counts: PollingRequestCounts = { date: 0, notifications: 0, week: 0 };
  await installMinuteIntervalController(page);
  await mockPeriodRoutes(page, () => false, () => false, () => Promise.resolve(), (kind) => {
    counts[kind] += 1;
  });
  await mockNotificationRoute(page, () => {
    counts.notifications += 1;
  });
  await login(page, `polling-hidden-${Date.now()}`);
  await expect.poll(() => counts.date + counts.week + counts.notifications).toBeGreaterThan(0);
  await expect.poll(() => minuteIntervalCount(page)).toBe(2);
  await drainTrackedFetches(page);

  await runMinuteIntervals(page, "hidden");

  expect(pollingCounts(await drainTrackedFetches(page))).toEqual({ date: 0, notifications: 0, week: 0 });
});

test("returning to the tab refreshes seat counts and updates the last refresh time", async ({ page }) => {
  let full = false;
  await mockPeriodRoutes(page, () => full);
  await login(page, `visible-refresh-${Date.now()}`);

  await expect(page.locator(".refresh-status")).toContainText("마지막 갱신");
  await expect(page.locator(".period-refresh-time")).toHaveCount(0);
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
  await mockAuth(page, buildMockSessionUser(loginId));
  await mockClientDate(page, e2eNow(FIXED_THURSDAY_DATE));
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.locator("input").nth(0).fill(loginId);
  await page.locator("input").nth(1).fill("password");
  await page.getByRole("button", { name: "인증하기" }).click();
  await page.locator(".period-card .period-badge").first().waitFor();
}

async function mockAuth(page: Page, user: MockSessionUser): Promise<void> {
  let currentUser: MockSessionUser | null = null;
  await page.route("**/api/me", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { user: currentUser } });
  });
  await page.route("**/api/auth/riro/login", async (route) => {
    currentUser = user;
    await route.fulfill({ contentType: "application/json", json: { user } });
  });
}

function buildMockSessionUser(loginId: string): MockSessionUser {
  const digits = loginId.replace(/\D/gu, "");
  return {
    bookingStatus: "ACTIVE",
    generation: 25,
    id: `mock-${loginId}`,
    name: "테스트학생",
    restrictedUntil: null,
    restrictionReason: null,
    role: "STUDENT",
    studentNumber: digits.length >= 5 ? digits.slice(-5) : `9${digits.padStart(4, "0")}`
  };
}

async function mockPeriodRoutes(
  page: Page,
  isFull: () => boolean,
  shouldFail: () => boolean = () => false,
  beforeFulfill: () => Promise<void> = () => Promise.resolve(),
  onRequest: (kind: PeriodRequestKind) => void = () => undefined
): Promise<void> {
  await page.route("**/api/periods**", async (route) => {
    const url = new URL(route.request().url());
    const weekStart = url.searchParams.get("weekStart");
    const date = url.searchParams.get("date") ?? FIXED_THURSDAY_DATE;
    onRequest(weekStart ? "week" : "date");
    await beforeFulfill();
    if (shouldFail()) {
      await route.fulfill({
        body: JSON.stringify({ error: { message: "refresh failed" } }),
        contentType: "application/json",
        status: 500
      });
      return;
    }
    if (weekStart) {
      await route.fulfill({
        body: JSON.stringify({
          dates: SCHOOL_WEEK_DATES.map((weekDate) => ({
            date: weekDate,
            periods: [
              weekPeriod({
                availability: weekDate === FIXED_THURSDAY_DATE && isFull() ? 0 : 1,
                studyPeriod: "EIGHTH"
              }),
              weekPeriod({ availability: 4, studyPeriod: "FIRST" })
            ]
          }))
        }),
        contentType: "application/json",
        headers: {
          "Cache-Control": "private, max-age=0, must-revalidate",
          ETag: "\"test-week-etag\""
        },
        status: 200
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
      headers: {
        "Cache-Control": "private, max-age=0, must-revalidate",
        ETag: "\"test-date-etag\""
      },
      status: 200
    });
  });
}

async function mockNotificationRoute(page: Page, onRequest: () => void): Promise<void> {
  await page.route("**/api/me/notifications", async (route) => {
    onRequest();
    await route.fulfill({ contentType: "application/json", json: { notifications: [] }, status: 200 });
  });
}

async function installMinuteIntervalController(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const minuteIntervals = new Map<number, { readonly args: readonly unknown[]; readonly handler: TimerHandler }>();
    const trackedFetches: string[] = [];
    const nativeFetch = window.fetch.bind(window);
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    let nextMinuteIntervalId = -1;

    window.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      trackedFetches.push(input instanceof Request ? input.url : String(input));
      return nativeFetch(input, init);
    }) as typeof window.fetch;
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]): number => {
      if (timeout !== 60_000) {
        return nativeSetInterval(handler, timeout, ...args);
      }
      const id = nextMinuteIntervalId;
      nextMinuteIntervalId -= 1;
      minuteIntervals.set(id, { args, handler });
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number): void => {
      if (typeof id === "number" && minuteIntervals.delete(id)) {
        return;
      }
      nativeClearInterval(id);
    }) as typeof window.clearInterval;
    window.__drainTrackedFetches = (): readonly string[] => trackedFetches.splice(0);
    window.__minuteIntervalCount = (): number => minuteIntervals.size;
    window.__runMinuteIntervals = (): void => {
      for (const { args, handler } of minuteIntervals.values()) {
        if (typeof handler === "function") {
          handler(...args);
        }
      }
    };
  });
}

async function drainTrackedFetches(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => window.__drainTrackedFetches());
}

async function minuteIntervalCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__minuteIntervalCount());
}

async function runMinuteIntervals(page: Page, visibilityState: "hidden" | "visible"): Promise<void> {
  await page.evaluate((state) => {
    Object.defineProperty(document, "hidden", { configurable: true, value: state === "hidden" });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    window.__runMinuteIntervals();
  }, visibilityState);
}

function pollingCounts(urls: readonly string[]): PollingRequestCounts {
  const counts: PollingRequestCounts = { date: 0, notifications: 0, week: 0 };
  for (const value of urls) {
    const url = new URL(value, BASE_URL);
    if (url.pathname === "/api/me/notifications") {
      counts.notifications += 1;
    } else if (url.pathname === "/api/periods" && url.searchParams.has("weekStart")) {
      counts.week += 1;
    } else if (url.pathname === "/api/periods" && url.searchParams.has("date")) {
      counts.date += 1;
    }
  }
  return counts;
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

function weekPeriod(input: { readonly availability: number; readonly studyPeriod: StudyPeriod }) {
  return {
    studyPeriod: input.studyPeriod,
    openTime: "00:00",
    closeTime: "23:59",
    capacity: 10,
    reservedCount: 10 - input.availability,
    enabled: true,
    availability: input.availability,
    myReservationId: null
  };
}
