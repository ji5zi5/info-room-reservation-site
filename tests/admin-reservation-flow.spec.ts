import { expect, test, type Page } from "@playwright/test";

import { e2eNow, mockClientDate } from "./e2e-time";
import { todayKst } from "./kst-date";
import { csrfRequest, responseErrorCode } from "./playwright-csrf";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

type StudyPeriod = "EIGHTH" | "FIRST";

type AdminPeriodSetting = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: StudyPeriod;
};

async function login(page: Page, loginId: string, fixedIso = e2eNow()): Promise<void> {
  if (loginId === "admin") {
    await loginWithApi(page, loginId, fixedIso);
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "관리자" })).toBeVisible();
    return;
  }
  await mockClientDate(page, fixedIso);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.locator("input").nth(0).fill(loginId);
  await page.locator("input").nth(1).fill("password");
  await page.getByRole("button", { name: "인증하기" }).click();
  await page.locator(".period-card .period-badge").first().waitFor();
}

async function logout(page: Page): Promise<void> {
  await csrfRequest(page, "/api/auth/logout", { method: "POST" });
}

async function loginWithApi(page: Page, loginId: string, fixedIso = e2eNow()): Promise<void> {
  await mockClientDate(page, fixedIso);
  const response = await page.request.post(`${BASE_URL}/api/auth/riro/login`, {
    data: { id: loginId, password: "password" },
    headers: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` }
  });
  expect(response.ok()).toBeTruthy();
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
  const response = await csrfRequest(page, "/api/admin/period-settings", {
    json: {
      date,
      periods: periods.map((period) => ({
        capacity: period.capacity,
        closeTime: period.closeTime,
        enabled: period.enabled,
        openTime: period.openTime,
        studyPeriod: period.studyPeriod
      }))
    },
    method: "PATCH"
  });
  if (!response.ok()) {
    throw new Error("period settings patch failed");
  }
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
    const studentToast = page.locator(".student-toast").filter({ hasText: "예약 이용이 제한되었습니다." });
    await expect(studentToast).toBeVisible();
    await page.getByRole("button", { name: "왼쪽 패널 접기" }).click();
    await expect(studentToast).toBeVisible();
    const toastBox = await studentToast.boundingBox();
    const viewport = page.viewportSize();
    expect(toastBox?.y, "student toast should stay near the top edge").toBeLessThan(120);
    expect(Math.abs((toastBox?.x ?? 0) + (toastBox?.width ?? 0) / 2 - (viewport?.width ?? 0) / 2)).toBeLessThan(80);
  } finally {
    await logout(page);
    await login(page, "admin");
    await patchPeriodSettings(page, date, originalPeriods);
  }
});

test("closed reservation periods show disabled closed action instead of reserve", async ({ page }) => {
  const date = todayKst();
  await login(page, "admin");
  const originalPeriods = await fetchPeriodSettings(page, date);
  await patchPeriodSettings(
    page,
    date,
    originalPeriods.map((period) => ({
      ...period,
      capacity: 10,
      closeTime: "00:00",
      enabled: true,
      openTime: "00:00"
    }))
  );
  await logout(page);

  try {
    await login(page, `closed-card-${Date.now()}`);
    const eighthCard = page.locator(".period-card").filter({ hasText: "8면학" }).first();
    await expect(eighthCard.getByRole("button", { name: "8면학 예약" })).toHaveCount(0);
    const closedAction = eighthCard.getByRole("button", { name: "마감" });
    await expect(closedAction).toBeVisible();
    await expect(closedAction).toBeDisabled();
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

  const response = await csrfRequest(page, "/api/reservations", {
    json: { date: todayKst(), studyPeriod: "EIGHTH" },
    method: "POST"
  });

  expect({ code: await responseErrorCode(response), status: response.status() }).toEqual({
    code: "admin_not_reservable",
    status: 403
  });
  await expect(page.getByRole("button", { name: "8면학 예약" })).toHaveCount(0);
});
