import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import path from "node:path";
import { z } from "zod";

import type { StudentPeriodSummary, StudentPeriodWeekPeriod } from "../src/lib/student-period-summary";
import type { StudentProfilePayload } from "../src/lib/student-profile";
import { e2eNow, FIXED_THURSDAY_DATE, mockClientDate } from "./e2e-time";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SCHOOL_WEEK_DATES = ["2026-06-08", "2026-06-09", "2026-06-10", FIXED_THURSDAY_DATE, "2026-06-12"] as const;
const VIEWPORTS = [
  { height: 844, label: "mobile", width: 390 },
  { height: 900, label: "desktop", width: 1440 }
] as const;
const LoginRequestSchema = z.object({
  id: z.string().trim().min(1),
  password: z.string().min(1)
});
const ReservationRequestSchema = z.object({
  date: z.literal(FIXED_THURSDAY_DATE),
  reason: z.string().trim().min(1),
  studyPeriod: z.enum(["EIGHTH", "FIRST"])
});

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

type FixtureOptions = {
  readonly holdMutation?: boolean;
  readonly profileResponse?: "error" | "loaded";
  readonly reservationId?: string | null;
};

type RouteFixture = {
  readonly mutationCount: () => number;
  readonly mutationStarted: Promise<void>;
  readonly releaseMutation: () => void;
};

for (const viewport of VIEWPORTS) {
  test(`collapsed sidebar descendants stay outside native Tab traversal at ${viewport.label} viewport`, async ({ page }) => {
    // Given
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await installRoutes(page);
    await login(page, `sidebar-${viewport.label}`);
    const toggle = page.getByRole("button", { name: /내 정보 패널 (?:접기|열기)/u });
    if ((await toggle.getAttribute("aria-expanded")) === "true") {
      await toggle.click();
    }
    const sidebarContentVisibility = await page.evaluate(() => {
      const sidebarContent = document.querySelector(".sidebar-content");
      if (!(sidebarContent instanceof HTMLElement)) {
        throw new Error("Expected sidebar content to exist after collapsing the sidebar.");
      }
      return getComputedStyle(sidebarContent).visibility;
    });
    expect(sidebarContentVisibility).toBe("hidden");
    await expect(page.getByRole("button", { name: "내 정보 패널 열기" })).toBeVisible();
    await toggle.focus();

    // When / Then: use the browser's sequential focus navigation, not an ARIA-only assertion.
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press("Tab");
      expect(await activeElementIsInside(page, ".sidebar-content")).toBe(false);
    }

    if (viewport.label === "mobile") {
      await page.screenshot({
        fullPage: true,
        path: path.join(requiredEvidenceDir(), "task-3-site-production-operations-hardening.png")
      });
    }
  });
}

test("login commits the selected week before the empty-date fallback runs", async ({ page }) => {
  // Given
  await page.setViewportSize({ height: 900, width: 1440 });
  await installRoutes(page);

  // When
  await login(page, "week-commit-before-empty-fallback");

  // Then
  const periodLabels = page.locator(".period-card .period-badge");
  await expect(periodLabels).toHaveCount(2);
  await expect(periodLabels.nth(0)).toHaveText("8면학");
  await expect(periodLabels.nth(1)).toHaveText("1면학");
});

test("reserve dialog focuses the reason, wraps both ways, and restores its exact opener", async ({ page }) => {
  // Given
  await page.setViewportSize({ height: 900, width: 1440 });
  await installRoutes(page);
  await login(page, "reserve-focus");
  const opener = reserveButton(page);

  // When
  await opener.click();

  // Then
  const dialog = page.getByRole("dialog", { name: "8면학 예약할까요?" });
  const first = dialog.getByRole("button", { name: "확인 창 닫기" });
  const reason = dialog.getByRole("textbox", { name: "이용 사유" });
  const last = dialog.getByRole("button", { name: "신청하기" });
  await expect(reason).toBeFocused();
  await reason.fill("키보드 포커스 회귀 검증");
  await expect(last).toBeEnabled();
  await expectTwoWayWrap(page, first, last);
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("student cancel dialog focuses confirmation, wraps both ways, and restores its exact opener", async ({ page }) => {
  // Given
  await page.setViewportSize({ height: 844, width: 390 });
  await installRoutes(page, { reservationId: "reservation-cancel-focus" });
  await login(page, "cancel-focus");
  const opener = cancelButton(page);

  // When
  await opener.click();

  // Then
  const dialog = page.getByRole("dialog", { name: "예약을 취소할까요?" });
  const first = dialog.getByRole("button", { name: "확인 창 닫기" });
  const confirmation = dialog.getByRole("checkbox", { name: "정말 취소하려면 이 확인란을 선택하세요." });
  const last = dialog.getByRole("button", { name: "취소 확정" });
  await expect(confirmation).toBeFocused();
  await confirmation.check();
  await expect(last).toBeEnabled();
  await expectTwoWayWrap(page, first, last);
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("loaded profile focuses its close button, wraps both ways, and restores its exact opener", async ({ page }) => {
  // Given
  await page.setViewportSize({ height: 900, width: 1440 });
  await installRoutes(page, { profileResponse: "loaded" });
  await login(page, "profile-loaded-focus");
  const opener = profileButton(page);

  // When
  await opener.click();

  // Then
  const dialog = page.getByRole("dialog", { name: "프로필" });
  const close = dialog.getByRole("button", { name: "닫기" });
  await expect(dialog.getByText("현재 예약 없음")).toBeVisible();
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  await close.click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("direct profile error focuses retry, wraps both ways, and restores its exact opener", async ({ page }) => {
  // Given
  await page.setViewportSize({ height: 844, width: 390 });
  await installRoutes(page, { profileResponse: "error" });
  await login(page, "profile-error-focus");
  await expandSidebar(page);
  const opener = profileButton(page);

  // When
  await opener.click();

  // Then
  const dialog = page.getByRole("dialog", { name: "프로필" });
  const close = dialog.getByRole("button", { name: "닫기" });
  const retry = dialog.getByRole("button", { name: "다시 시도" });
  await expect(retry).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(retry).toBeFocused();
  await close.click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("pending reserve ignores every dismissal path and repeated confirmation without duplicating POST", async ({ page }) => {
  // Given
  await page.setViewportSize({ height: 900, width: 1440 });
  const fixture = await installRoutes(page, { holdMutation: true });
  await login(page, "reserve-pending");
  const opener = reserveButton(page);
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "8면학 예약할까요?" });
  const reason = dialog.getByRole("textbox", { name: "이용 사유" });
  const confirm = dialog.getByRole("button", { name: "신청하기" });
  await reason.fill("보류 중 예약 포커스 유지");

  // When
  await confirm.click();
  await fixture.mutationStarted;

  // Then
  try {
    await expectPendingDismissalsBlocked(page, dialog, confirm);
    expect(fixture.mutationCount()).toBe(1);
    await expect(reason).toHaveValue("보류 중 예약 포커스 유지");
  } finally {
    fixture.releaseMutation();
  }
  await expect(page.getByText("보류된 요청 실패", { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(reason).toHaveValue("보류 중 예약 포커스 유지");
  await expect(confirm).toBeFocused();
});

test("pending cancellation ignores every dismissal path and repeated confirmation without duplicating DELETE", async ({ page }) => {
  // Given
  await page.setViewportSize({ height: 844, width: 390 });
  const fixture = await installRoutes(page, {
    holdMutation: true,
    reservationId: "reservation-cancel-pending"
  });
  await login(page, "cancel-pending");
  const opener = cancelButton(page);
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "예약을 취소할까요?" });
  const confirmation = dialog.getByRole("checkbox", { name: "정말 취소하려면 이 확인란을 선택하세요." });
  const confirm = dialog.getByRole("button", { name: "취소 확정" });
  await confirmation.check();

  // When
  await confirm.click();
  await fixture.mutationStarted;

  // Then
  try {
    await expectPendingDismissalsBlocked(page, dialog, confirm);
    expect(fixture.mutationCount()).toBe(1);
    await expect(confirmation).toBeChecked();
  } finally {
    fixture.releaseMutation();
  }
  await expect(page.getByText("보류된 요청 실패", { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(confirmation).toBeChecked();
  await expect(confirm).toBeFocused();
});

async function installRoutes(page: Page, options: FixtureOptions = {}): Promise<RouteFixture> {
  const reservationId = options.reservationId ?? null;
  const mutationGate = deferred();
  const mutationSignal = deferred();
  let currentUser: SessionUser | null = null;
  let mutationCount = 0;

  await page.route("**/api/**", (route) => route.fulfill({ json: { error: { message: "unmocked API route" } }, status: 501 }));
  await page.route("**/api/me", (route) => route.fulfill({ json: { user: currentUser }, status: 200 }));
  await page.route("**/api/auth/riro/login", async (route) => {
    const body = parseRequestBody(route, LoginRequestSchema);
    if (body === null) {
      await route.fulfill({ json: { error: { message: "invalid login fixture request" } }, status: 400 });
      return;
    }
    currentUser = studentUser(body.id);
    await route.fulfill({ json: { user: currentUser }, status: 200 });
  });
  await page.route("**/api/periods**", (route) => fulfillPeriods(route, reservationId));
  await page.route("**/api/me/notifications", (route) => route.fulfill({ json: { notifications: [] }, status: 200 }));
  await page.route("**/api/me/profile", (route) => {
    if (options.profileResponse === "error") {
      return route.fulfill({ json: { error: { message: "프로필 fixture 실패" } }, status: 503 });
    }
    return route.fulfill({ json: profilePayload(currentUser ?? studentUser("profile-fixture")), status: 200 });
  });
  await page.route("**/api/csrf", (route) => route.fulfill({ json: { csrfToken: "keyboard-fixture-csrf" }, status: 200 }));
  await page.route("**/api/reservations", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({ json: { error: { message: "unexpected reservation method" } }, status: 405 });
      return;
    }
    const body = parseRequestBody(route, ReservationRequestSchema);
    if (body === null) {
      await route.fulfill({ json: { error: { message: "invalid reservation fixture request" } }, status: 400 });
      return;
    }
    mutationCount += 1;
    mutationSignal.resolve();
    if (options.holdMutation) {
      await mutationGate.promise;
    }
    await route.fulfill({ json: { error: { message: "보류된 요청 실패" } }, status: 503 });
  });
  await page.route("**/api/reservations/*", async (route) => {
    const requestPath = new URL(route.request().url()).pathname;
    if (route.request().method() !== "DELETE" || requestPath !== `/api/reservations/${reservationId ?? ""}`) {
      await route.fulfill({ json: { error: { message: "invalid cancellation fixture request" } }, status: 400 });
      return;
    }
    mutationCount += 1;
    mutationSignal.resolve();
    if (options.holdMutation) {
      await mutationGate.promise;
    }
    await route.fulfill({ json: { error: { message: "보류된 요청 실패" } }, status: 503 });
  });

  return {
    mutationCount: () => mutationCount,
    mutationStarted: mutationSignal.promise,
    releaseMutation: mutationGate.resolve
  };
}

async function login(page: Page, id: string): Promise<void> {
  await mockClientDate(page, e2eNow(FIXED_THURSDAY_DATE));
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.getByRole("textbox", { name: "리로스쿨 ID" }).fill(id);
  await page.getByLabel("리로스쿨 PW").fill("keyboard-fixture-password");
  await page.getByRole("button", { name: "인증하기" }).click();
  await expect(page.locator(".period-card")).toHaveCount(2);
}

async function fulfillPeriods(route: Route, reservationId: string | null): Promise<void> {
  const url = new URL(route.request().url());
  if (url.searchParams.has("weekStart")) {
    await route.fulfill({
      headers: { ETag: '"keyboard-fixture"' },
      json: {
        dates: SCHOOL_WEEK_DATES.map((date) => ({
          date,
          periods: [weekPeriod(date, "EIGHTH", reservationId), weekPeriod(date, "FIRST", null)]
        }))
      },
      status: 200
    });
    return;
  }
  const date = url.searchParams.get("date") ?? FIXED_THURSDAY_DATE;
  await route.fulfill({
    json: {
      periods: [datePeriod(date, "EIGHTH", "8면학", reservationId), datePeriod(date, "FIRST", "1면학", null)]
    },
    status: 200
  });
}

async function expectTwoWayWrap(page: Page, first: Locator, last: Locator): Promise<void> {
  await first.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
}

async function expectPendingDismissalsBlocked(page: Page, dialog: Locator, confirm: Locator): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.locator(".confirm-backdrop").dispatchEvent("mousedown");
  await page.locator(".confirm-backdrop").dispatchEvent("click");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "확인 창 닫기" }).dispatchEvent("click");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "닫기", exact: true }).dispatchEvent("click");
  await expect(dialog).toBeVisible();
  await confirm.dispatchEvent("click");
  await confirm.dispatchEvent("click");
  await expect(dialog).toBeVisible();
}

async function activeElementIsInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((containerSelector) => {
    const activeElement = document.activeElement;
    const container = document.querySelector(containerSelector);
    return activeElement !== null && container !== null && container.contains(activeElement);
  }, selector);
}

async function expandSidebar(page: Page): Promise<void> {
  const open = page.getByRole("button", { name: "내 정보 패널 열기" });
  if (await open.isVisible()) {
    await open.click();
  }
}

function reserveButton(page: Page): Locator {
  return page.locator(".period-card").filter({ hasText: "8면학" }).getByRole("button", { name: "8면학 예약" });
}

function cancelButton(page: Page): Locator {
  return page.locator(".period-card").filter({ hasText: "8면학" }).getByRole("button", { name: "예약 취소" });
}

function profileButton(page: Page): Locator {
  return page.getByRole("button", { name: "프로필", exact: true });
}

function studentUser(id: string): SessionUser {
  return {
    bookingStatus: "ACTIVE",
    generation: 30,
    id,
    name: "키보드 테스트 학생",
    restrictionReason: null,
    restrictedUntil: null,
    role: "STUDENT",
    studentNumber: "32001"
  };
}

function weekPeriod(date: string, studyPeriod: "EIGHTH" | "FIRST", reservationId: string | null): StudentPeriodWeekPeriod {
  const weeklyReservationId = reservationId === null || date === FIXED_THURSDAY_DATE ? reservationId : `${reservationId}-${date}`;
  return {
    availability: weeklyReservationId === null ? 10 : 9,
    capacity: 10,
    closeTime: "23:59",
    enabled: true,
    myReservationId: weeklyReservationId,
    openTime: "00:00",
    reservedCount: weeklyReservationId === null ? 0 : 1,
    studyPeriod
  };
}

function datePeriod(
  date: string,
  studyPeriod: "EIGHTH" | "FIRST",
  label: string,
  reservationId: string | null
): StudentPeriodSummary {
  return {
    capacity: 10,
    closeTime: "23:59",
    confirmedCount: reservationId === null ? 0 : 1,
    date,
    enabled: true,
    label,
    myReservationId: reservationId,
    openTime: "00:00",
    remaining: reservationId === null ? 10 : 9,
    studyPeriod,
    windowState: "open"
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

function parseRequestBody<T>(route: Route, schema: z.ZodType<T>): T | null {
  const rawBody = route.request().postData();
  if (rawBody === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(rawBody);
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function requiredEvidenceDir(): string {
  const value = process.env.EVIDENCE_DIR;
  if (!value) {
    throw new Error("EVIDENCE_DIR is required for Todo 3 keyboard evidence.");
  }
  return value;
}
