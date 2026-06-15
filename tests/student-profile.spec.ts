import { expect, test, type Page } from "@playwright/test";

import type { StudentProfilePayload } from "../src/lib/student-profile";
import { e2eNow, mockClientDate, mockOpenPeriodsForDates, FIXED_THURSDAY_DATE } from "./e2e-time";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

const FORBIDDEN_PROFILE_KEYS = [
  "adminActions",
  "auditLogs",
  "sessionSummary",
  "actorId",
  "sourceActionId",
  "revokedById",
  "riroId",
  "userId"
] as const;

type ProfileStatusFixture = {
  readonly bookingStatus: StudentProfilePayload["user"]["bookingStatus"];
  readonly effectiveStatus: StudentProfilePayload["effectiveStatus"];
  readonly restrictionReason: string | null;
  readonly restrictedUntil: string | null;
  readonly statusMessage: StudentProfilePayload["statusMessage"];
};

const RESTRICTED_PROFILE_CASES = [
  {
    bookingStatus: "BANNED",
    effectiveStatus: "BANNED",
    restrictionReason: "관리자 제한",
    restrictedUntil: null,
    statusMessage: "영구 제한"
  },
  {
    bookingStatus: "RESTRICTED",
    effectiveStatus: "RESTRICTED",
    restrictionReason: "예약 취소",
    restrictedUntil: "2026-06-18T00:00:00.000Z",
    statusMessage: "예약 제한"
  }
] as const satisfies readonly ProfileStatusFixture[];

const PROFILE_ERROR_CASES = [
  { body: "{", message: "프로필 응답을 읽을 수 없습니다.", name: "malformed JSON", status: 200 },
  { body: "", message: "프로필 응답이 비어 있습니다.", name: "empty body", status: 204 }
] as const;

async function openHome(page: Page): Promise<void> {
  await mockClientDate(page, e2eNow(FIXED_THURSDAY_DATE));
  await mockOpenPeriodsForDates(page, FIXED_THURSDAY_DATE);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "예약 현황" })).toBeVisible();
}

async function loginAsStudent(page: Page): Promise<void> {
  await openHome(page);
  await page.locator("input").nth(0).fill(`profile-${Date.now()}`);
  await page.locator("input").nth(1).fill("password");
  await page.getByRole("button", { name: "인증하기" }).click();
  await page.locator(".period-card .period-badge").first().waitFor();
  await expect(profileButton(page)).toBeVisible();
}

async function loginAsAdmin(page: Page): Promise<void> {
  await mockClientDate(page, e2eNow(FIXED_THURSDAY_DATE));
  const response = await page.request.post(`${BASE_URL}/api/auth/riro/login`, {
    data: { id: "admin", password: "password" },
    headers: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` }
  });
  expect(response.ok()).toBeTruthy();
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "관리자" })).toBeVisible();
}

async function openProfile(page: Page) {
  await profileButton(page).click();
  const dialog = page.getByRole("dialog", { name: "프로필" });
  await expect(dialog).toBeVisible();
  return dialog;
}

function profileButton(page: Page) {
  return page.getByRole("button", { name: "프로필" });
}

async function fulfillProfile(page: Page, profile: StudentProfilePayload): Promise<void> {
  await page.route("**/api/me/profile", async (route) => {
    await route.fulfill({
      body: JSON.stringify(profile),
      contentType: "application/json",
      status: 200
    });
  });
}

test("logged-out users do not see the profile button", async ({ page }) => {
  // Given
  await openHome(page);

  // Then
  await expect(profileButton(page)).toHaveCount(0);
});

test("admin users do not see the student profile button", async ({ page }) => {
  // Given
  await loginAsAdmin(page);

  // Then
  await expect(profileButton(page)).toHaveCount(0);
});

test("mock student login opens a loaded profile", async ({ page }) => {
  // Given
  await loginAsStudent(page);

  // When
  const dialog = await openProfile(page);

  // Then
  await expect(dialog.locator(".student-profile-status")).toContainText(/예약 가능|예약 제한|영구 제한/u);
  await expect(dialog.getByText("확정")).toBeVisible();
  await expect(dialog.getByText("취소")).toBeVisible();
  await expect(dialog.getByText("미출석")).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "현재 예약" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "최근 이력" })).toBeVisible();
  await expect(dialog.getByText("현재 예약 없음")).toBeVisible();
  await expect(dialog.getByText("최근 이력 없음")).toBeVisible();
  await expect(dialog.getByText("제재 이력 없음")).toBeVisible();
  const bodyText = await page.locator("body").innerText();
  for (const key of FORBIDDEN_PROFILE_KEYS) {
    expect(bodyText).not.toContain(key);
  }
});

for (const profileErrorCase of PROFILE_ERROR_CASES) {
  test(`${profileErrorCase.name} profile responses show a recoverable panel error`, async ({ page }) => {
    // Given
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/api/me/profile", async (route) => {
      await route.fulfill({
        body: profileErrorCase.body,
        contentType: "application/json",
        status: profileErrorCase.status
      });
    });
    await loginAsStudent(page);

    // When
    const dialog = await openProfile(page);

    // Then
    await expect(dialog.getByText(profileErrorCase.message)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "다시 시도" })).toBeVisible();
    expect(pageErrors.some((message) => message.includes("Unexpected end of JSON input"))).toBe(false);
  });
}

test("logout closes an open profile panel", async ({ page }) => {
  // Given
  await loginAsStudent(page);
  await openProfile(page);

  // When
  await page.getByRole("button", { name: "로그아웃" }).dispatchEvent("click");

  // Then
  await expect(page.getByRole("dialog", { name: "프로필" })).toHaveCount(0);
  await expect(profileButton(page)).toHaveCount(0);
  await expect(page.getByText("로그아웃되었습니다.")).toBeVisible();
});

test("390px mobile profile panel does not overflow horizontally", async ({ page }) => {
  // Given
  await page.setViewportSize({ height: 844, width: 390 });
  await loginAsStudent(page);

  // When
  await openProfile(page);

  // Then
  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));

  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
});

for (const profileCase of RESTRICTED_PROFILE_CASES) {
  test(`intercepted ${profileCase.effectiveStatus} profile renders ${profileCase.statusMessage}`, async ({ page }) => {
    // Given
    await fulfillProfile(page, buildProfileFixture(profileCase));
    await loginAsStudent(page);

    // When
    const dialog = await openProfile(page);

    // Then
    await expect(dialog.locator(".student-profile-status")).toHaveText(profileCase.statusMessage);
    if (profileCase.restrictionReason !== null && profileCase.restrictedUntil === null) {
      await expect(dialog.getByText(profileCase.restrictionReason, { exact: true })).toBeVisible();
    }
    if (profileCase.restrictedUntil !== null) {
      await expect(dialog.getByText(`${profileCase.restrictionReason} ${profileCase.restrictedUntil.slice(0, 10)}`, { exact: true })).toBeVisible();
      await expect(dialog.getByText(`2026-06-14 - ${profileCase.restrictedUntil.slice(0, 10)} ${profileCase.restrictionReason}`)).toBeVisible();
    } else {
      await expect(dialog.getByText(`2026-06-14 - 영구 제한 ${profileCase.restrictionReason}`)).toBeVisible();
    }
  });
}

function buildProfileFixture(profileStatus: ProfileStatusFixture): StudentProfilePayload {
  return {
    currentReservations: [
      {
        createdAt: "2026-06-15T04:00:00.000Z",
        date: "2026-06-16",
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        updatedAt: "2026-06-15T04:00:00.000Z"
      }
    ],
    effectiveStatus: profileStatus.effectiveStatus,
    recentReservations: [
      {
        createdAt: "2026-06-14T04:00:00.000Z",
        date: "2026-06-14",
        status: "CANCELLED",
        studyPeriod: "FIRST",
        updatedAt: "2026-06-14T05:00:00.000Z"
      }
    ],
    recentSanctions: [
      {
        createdAt: "2026-06-14T05:00:00.000Z",
        endsAt: profileStatus.effectiveStatus === "BANNED" ? null : "2026-06-18T00:00:00.000Z",
        reason: profileStatus.restrictionReason ?? "예약 제한",
        revokedAt: null,
        startsAt: "2026-06-14T05:00:00.000Z",
        status: "ACTIVE",
        type: profileStatus.effectiveStatus === "BANNED" ? "PERMANENT_BAN" : "CANCEL_RESTRICTION"
      }
    ],
    reservationSummary: {
      cancelledCount: 1,
      confirmedCount: 1,
      noShowCount: 0
    },
    sanctionSummary: {
      activeCount: 1,
      permanentCount: profileStatus.effectiveStatus === "BANNED" ? 1 : 0,
      revokedCount: 0,
      totalCount: 1
    },
    statusMessage: profileStatus.statusMessage,
    user: {
      bookingStatus: profileStatus.bookingStatus,
      generation: 12,
      name: "김학생",
      restrictionReason: profileStatus.restrictionReason,
      restrictedUntil: profileStatus.restrictedUntil,
      role: "STUDENT",
      studentNumber: "1201"
    }
  };
}
