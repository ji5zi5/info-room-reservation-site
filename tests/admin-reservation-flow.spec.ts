import { expect, test, type Page } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

type StudyPeriod = "EIGHTH" | "FIRST";

type AdminPeriodSetting = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: StudyPeriod;
};

async function login(page: Page, loginId: string): Promise<void> {
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
    async ({ nextPeriods, targetDate }) => {
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

function todayKst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Seoul",
    year: "numeric"
  }).format(new Date());
}

test("non-admin users are redirected away from admin page", async ({ page }) => {
  await login(page, `student-${Date.now()}`);

  await page.goto(`${BASE_URL}/admin`, { waitUntil: "networkidle" });

  await expect(page).toHaveURL(/\/(?:\?admin=forbidden)?$/u);
  await expect(page.getByRole("heading", { name: "관리자" })).toHaveCount(0);
  await expect(page.getByText("관리자 권한이 필요합니다.")).toBeVisible();
});

test("reserved periods show a cancel action and refresh applicants after cancel", async ({ page }) => {
  const date = todayKst();
  await mockClientDate(page, `${date}T09:00:00+09:00`);
  await login(page, "admin");
  const originalPeriods = await fetchPeriodSettings(page, date);
  await patchPeriodSettings(
    page,
    date,
    originalPeriods.map((period) => ({
      ...period,
      capacity: 10,
      closeTime: "23:59",
      enabled: true,
      openTime: "00:00"
    }))
  );
  await logout(page);

  try {
    const loginId = `cancel-${Date.now()}`;
    await login(page, loginId);
    await expect(page.getByText("신청 후 미참석 시 정보실 예약이 영구 제한됩니다.")).toBeVisible();
    await expect(page.getByText("예약 취소 시 3일간 예약이 제한됩니다.")).toBeVisible();
    const eighthCard = page.locator(".period-card").filter({ hasText: "8면학" }).first();
    await eighthCard.getByRole("button", { name: "8면학 예약" }).click();
    await expect(page.getByRole("dialog", { name: "8면학 예약할까요?" })).toBeVisible();
    await page.getByRole("button", { exact: true, name: "닫기" }).click();
    await expect(page.getByRole("dialog", { name: "8면학 예약할까요?" })).toHaveCount(0);
    await expect(eighthCard.getByRole("button", { name: "예약됨" })).toHaveCount(0);
    await eighthCard.getByRole("button", { name: "8면학 예약" }).click();
    await page.getByRole("button", { name: "예약 확정" }).click();
    await expect(eighthCard.getByRole("button", { name: "예약됨" })).toBeVisible();
    await expect(eighthCard.getByRole("button", { name: "예약 취소" })).toBeVisible();

    await eighthCard.getByRole("button", { name: /신청자 \d+명 보기/u }).click();
    await expect(eighthCard.getByText(loginId.replace(/\D/gu, "").slice(-5))).toBeVisible();

    await eighthCard.getByRole("button", { name: "예약 취소" }).click();
    await expect(page.getByRole("dialog", { name: "예약을 취소할까요?" })).toBeVisible();
    await page.getByRole("button", { exact: true, name: "닫기" }).click();
    await expect(eighthCard.getByRole("button", { name: "예약 취소" })).toBeVisible();
    await eighthCard.getByRole("button", { name: "예약 취소" }).click();
    await page.getByRole("button", { name: "취소 확정" }).click();

    await expect(page.getByText("예약이 취소되었습니다. 3일간 예약이 제한됩니다.")).toBeVisible();
    await expect(eighthCard.getByRole("button", { name: "8면학 예약" })).toBeVisible();
    await expect(eighthCard.getByRole("button", { name: "예약 취소" })).toHaveCount(0);
    await eighthCard.getByRole("button", { name: "8면학 예약" }).click();
    await expect(page.getByRole("dialog", { name: "8면학 예약할까요?" })).toHaveCount(0);
    await expect(page.getByText("예약 이용이 제한되었습니다.")).toBeVisible();
  } finally {
    await logout(page);
    await login(page, "admin");
    await patchPeriodSettings(page, date, originalPeriods);
  }
});

test("admin reservations default to confirmed and expose status filters", async ({ page }) => {
  await login(page, "admin");
  await page.getByRole("button", { name: "예약자" }).click();

  await expect(page.getByRole("button", { name: "확정" })).toHaveAttribute("data-active", "true");
  await page.getByRole("button", { name: "전체" }).click();
  await expect(page).toHaveURL(/status=ALL/u);
  await expect(page.getByRole("button", { name: "전체" })).toHaveAttribute("data-active", "true");
});

test("admins cannot create student reservations", async ({ page }) => {
  await login(page, "admin");

  const result = await page.evaluate(async (date) => {
    const response = await fetch("/api/reservations", {
      body: JSON.stringify({ date, studyPeriod: "EIGHTH" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    const payload = (await response.json()) as { readonly error?: { readonly code?: string } };
    return { code: payload.error?.code, status: response.status };
  }, todayKst());

  expect(result).toEqual({ code: "admin_not_reservable", status: 403 });
  await expect(page.getByRole("button", { name: "8면학 예약" })).toHaveCount(0);
});
