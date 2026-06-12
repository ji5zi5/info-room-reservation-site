import { expect, test, type Locator, type Page } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

type StudyPeriod = "EIGHTH" | "FIRST";

type AdminPeriodSetting = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: StudyPeriod;
};

type ReservationCreateResponse = {
  readonly reservation?: {
    readonly id?: string;
  };
};

async function login(page: Page, loginId = `date-first-${Date.now()}`): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.locator("input").nth(0).fill(loginId);
  await page.locator("input").nth(1).fill("password");
  await page.getByRole("button", { name: "인증하기" }).click();
  if (loginId === "admin") {
    await expect(page.getByRole("heading", { name: "관리자" })).toBeVisible();
    return;
  }
  await page.locator(".period-card .period-badge").first().waitFor();
}

async function logout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
  });
}

async function fetchPeriodSettings(page: Page, date: string): Promise<readonly AdminPeriodSetting[]> {
  return page.evaluate(async (targetDate) => {
    const response = await fetch(`/api/admin/period-settings?date=${targetDate}`);
    const payload = (await response.json()) as { readonly periods: readonly AdminPeriodSetting[] };
    return payload.periods;
  }, date);
}

async function patchPeriodSettings(
  page: Page,
  date: string,
  periods: readonly AdminPeriodSetting[]
): Promise<void> {
  await page.evaluate(
    async ({ targetDate, nextPeriods }) => {
      const response = await fetch("/api/admin/period-settings", {
        body: JSON.stringify({ date: targetDate, periods: nextPeriods }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      });
      if (!response.ok) {
        throw new Error("period settings patch failed");
      }
    },
    { nextPeriods: periods, targetDate: date }
  );
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

async function visibleBox(locator: Locator, label: string): Promise<{ readonly height: number; readonly width: number }> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`${label} should be visible`);
  }
  return { height: box.height, width: box.width };
}

async function visiblePosition(locator: Locator, label: string): Promise<{ readonly x: number; readonly y: number }> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`${label} should be visible`);
  }
  return { x: box.x, y: box.y };
}

function todayKst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Seoul",
    year: "numeric"
  }).format(new Date());
}

test("advance reservation shows date picker before period cards", async ({ page }) => {
  await mockClientDate(page, "2026-06-11T09:00:00+09:00");
  await login(page);
  await page.getByRole("button", { name: "사전예약" }).click();

  const datePicker = page.getByLabel("사전예약 날짜");
  await expect(datePicker).toBeVisible();
  await expect(datePicker).toHaveAttribute("min", "2026-06-12");
  await expect(datePicker).toHaveAttribute("max", "2026-06-12");

  const datePickerBox = await datePicker.boundingBox();
  const firstPeriodBox = await page.locator(".period-card").first().boundingBox();
  expect(datePickerBox?.y, "advance date picker should render before period cards").toBeLessThan(
    firstPeriodBox?.y ?? 0
  );
});

test("home page omits redundant explanatory copy", async ({ page }) => {
  await page.goto(BASE_URL, { waitUntil: "networkidle" });

  await expect(page.getByText("정보실 사전 컨펌제 · 리로스쿨 인증")).toHaveCount(0);
});

test("mocked client date does not trigger a hydration mismatch", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await mockClientDate(page, "2026-06-11T09:00:00+09:00");

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "예약 현황" })).toBeVisible();
  await page.waitForTimeout(300);

  expect(pageErrors.filter((message) => message.includes("Hydration failed"))).toEqual([]);
});

test("reservation header copy is compact and tabs keep stable dimensions", async ({ page }) => {
  await mockClientDate(page, "2026-06-11T09:00:00+09:00");
  await login(page);

  await expect(page.getByText("8면학 먼저, 다음 1면학")).toHaveCount(0);
  await expect(page.getByText("리로스쿨 인증")).toHaveCount(0);

  const todayTab = page.getByRole("button", { name: "당일예약" });
  const advanceTab = page.getByRole("button", { name: "사전예약" });
  const todayBefore = await visibleBox(todayTab, "today tab");
  const advanceBefore = await visibleBox(advanceTab, "advance tab");
  expect(Math.round(todayBefore.width)).toBe(Math.round(advanceBefore.width));
  expect(Math.round(todayBefore.height)).toBe(Math.round(advanceBefore.height));

  await advanceTab.click();
  const todayAfter = await visibleBox(todayTab, "today tab after switch");
  const advanceAfter = await visibleBox(advanceTab, "advance tab after switch");
  expect(Math.round(todayAfter.width)).toBe(Math.round(todayBefore.width));
  expect(Math.round(advanceAfter.height)).toBe(Math.round(advanceBefore.height));
});

test("today and advance tabs keep period cards on the same visual rail", async ({ page }) => {
  await mockClientDate(page, "2026-06-11T09:00:00+09:00");
  await login(page, `rail-${Date.now()}`);

  const firstCard = page.locator(".period-card").first();
  const todayPosition = await visiblePosition(firstCard, "today first period card");

  await page.getByRole("button", { name: "사전예약" }).click();
  await expect(page.getByLabel("사전예약 날짜")).toBeVisible();
  const advancePosition = await visiblePosition(firstCard, "advance first period card");

  await page.getByRole("button", { name: "당일예약" }).click();
  const todayAgainPosition = await visiblePosition(firstCard, "today first period card after return");

  expect(Math.abs(Math.round(advancePosition.y - todayPosition.y))).toBeLessThanOrEqual(2);
  expect(Math.abs(Math.round(todayAgainPosition.y - todayPosition.y))).toBeLessThanOrEqual(2);
});

test("left panel collapses and expands", async ({ page }) => {
  await login(page);

  const panel = page.locator(".login-panel");
  const openBox = await visibleBox(panel, "open left panel");
  await page.getByRole("button", { name: "왼쪽 패널 접기" }).click();

  await expect(page.getByRole("button", { name: "왼쪽 패널 열기" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "정보실 예약" })).toBeHidden();
  await expect.poll(async () => (await visibleBox(panel, "closed left panel")).width).toBeLessThan(openBox.width / 2);

  await page.getByRole("button", { name: "왼쪽 패널 열기" }).click();
  await expect(page.getByRole("button", { name: "왼쪽 패널 접기" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "정보실 예약" })).toBeVisible();
});

test("period cards show confirmed applicants", async ({ page }) => {
  const date = todayKst();
  const studentNumber = String(Math.floor(10_000 + Math.random() * 90_000));
  let reservationId: string | undefined;
  let originalPeriods: readonly AdminPeriodSetting[] = [];
  await mockClientDate(page, `${date}T09:00:00+09:00`);
  await login(page, "admin");
  originalPeriods = await fetchPeriodSettings(page, date);
  await patchPeriodSettings(
    page,
    date,
    originalPeriods.map((period) => ({
      ...period,
      capacity: Math.max(period.capacity, 200),
      closeTime: "23:59",
      enabled: true,
      openTime: "00:00"
    }))
  );
  await logout(page);

  try {
    await login(page, `applicant-${studentNumber}`);
    const eighthCard = page.locator(".period-card").filter({ hasText: "8면학" }).first();
    const reservationResponsePromise = page.waitForResponse(
      (response) => response.url().endsWith("/api/reservations") && response.request().method() === "POST"
    );
    await eighthCard.getByRole("button", { name: "8면학 예약" }).click();

    const reservationResponse = await reservationResponsePromise;
    const payload = (await reservationResponse.json()) as ReservationCreateResponse;
    reservationId = payload.reservation?.id;
    if (!reservationId) {
      throw new Error("reservation id missing from create response");
    }

    await expect(page.getByText("예약이 확정되었습니다.")).toBeVisible();
    const applicantToggle = eighthCard.getByRole("button", { name: /신청자 \d+명 보기/u });
    await expect(applicantToggle).toBeVisible();
    await expect(eighthCard.getByText(studentNumber)).toBeHidden();

    await applicantToggle.click();
    await expect(eighthCard.getByRole("button", { name: "신청자 접기" })).toBeVisible();
    await expect(eighthCard.getByText(studentNumber)).toBeVisible();

    await eighthCard.getByRole("button", { name: "신청자 접기" }).click();
    await expect(eighthCard.getByText(studentNumber)).toBeHidden();
  } finally {
    if (reservationId) {
      await page.evaluate(async (id) => {
        await fetch(`/api/reservations/${id}`, { method: "DELETE" });
      }, reservationId);
    }
    await logout(page);
    await login(page, "admin");
    await patchPeriodSettings(page, date, originalPeriods);
  }
});

test("applicant toggle preserves period order and tab dimensions", async ({ page }) => {
  await mockClientDate(page, "2026-06-11T09:00:00+09:00");
  await login(page, "25-10316");

  const todayTab = page.getByRole("button", { name: "당일예약" });
  const advanceTab = page.getByRole("button", { name: "사전예약" });
  const todayBefore = await visibleBox(todayTab, "today tab before applicant toggle");
  const advanceBefore = await visibleBox(advanceTab, "advance tab before applicant toggle");
  const periodBadges = page.locator(".period-badge");
  await expect(periodBadges.nth(0)).toHaveText("8면학");
  await expect(periodBadges.nth(1)).toHaveText("1면학");

  await page.locator(".period-card").filter({ hasText: "8면학" }).getByRole("button", { name: /신청자 .* 보기/u }).click();

  const todayAfter = await visibleBox(todayTab, "today tab after applicant toggle");
  const advanceAfter = await visibleBox(advanceTab, "advance tab after applicant toggle");
  expect(Math.round(todayAfter.width)).toBe(Math.round(todayBefore.width));
  expect(Math.round(todayAfter.height)).toBe(Math.round(todayBefore.height));
  expect(Math.round(advanceAfter.width)).toBe(Math.round(advanceBefore.width));
  expect(Math.round(advanceAfter.height)).toBe(Math.round(advanceBefore.height));
  await expect(periodBadges.nth(0)).toHaveText("8면학");
  await expect(periodBadges.nth(1)).toHaveText("1면학");
});

test("admin users see the operations console after normal login", async ({ page }) => {
  await login(page, "admin");

  await expect(page).toHaveURL(new RegExp(`^${BASE_URL.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/?$`, "u"));
  await expect(page.getByRole("heading", { name: "운영 대시보드" })).toBeVisible();
  await expect(page.getByRole("button", { name: "8면학 예약" })).toHaveCount(0);

  await page.goto(`${BASE_URL}/admin`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "운영 대시보드" })).toBeVisible();
});

test("advance reservation is unavailable on Friday", async ({ page }) => {
  await mockClientDate(page, "2026-06-12T09:00:00+09:00");
  await login(page);
  await page.getByRole("button", { name: "사전예약" }).click();

  await expect(page.getByRole("heading", { name: "사전예약 불가" })).toBeVisible();
  await expect(page.getByLabel("사전예약 날짜")).toHaveCount(0);
  await expect(page.locator(".period-card")).toHaveCount(0);
});
