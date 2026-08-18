import { expect, test, type Page, type Route } from "@playwright/test";
import path from "node:path";
import { z } from "zod";

import type { StudentPeriodSummary, StudentPeriodWeekPeriod } from "../src/lib/student-period-summary";
import type { StudentNotification } from "../src/lib/student-notifications";
import type { StudentProfilePayload } from "../src/lib/student-profile";
import { e2eNow, FIXED_THURSDAY_DATE, mockClientDate } from "./e2e-time";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SCHOOL_WEEK_DATES = ["2026-06-08", "2026-06-09", "2026-06-10", FIXED_THURSDAY_DATE, "2026-06-12"] as const;
const LoginRequestSchema = z.object({
  id: z.string().trim().min(1),
  password: z.string().min(1)
});

type SessionUser = {
  readonly bookingStatus: "ACTIVE" | "RESTRICTED";
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly restrictionReason: string | null;
  readonly restrictedUntil: string | null;
  readonly role: "STUDENT";
  readonly studentNumber: string;
};

type RefreshProfilePayload = Omit<StudentProfilePayload, "user"> & {
  readonly user: SessionUser;
};

type RefreshNotificationPayload = {
  readonly notifications: readonly StudentNotification[];
};

test("failed seat refresh keeps stale counts blocked until coordinated retry and captures final student views", async ({ page }) => {
  let currentUser: SessionUser | null = null;
  let periodFailure = false;
  await installBaseRoutes(page, () => currentUser, (user) => {
    currentUser = user;
  });
  await page.route("**/api/periods**", async (route) => {
    if (periodFailure) {
      await route.fulfill({ json: { error: { message: "temporary" } }, status: 500 });
      return;
    }
    await fulfillPeriods(route, 4);
  });

  await login(page, "student-a");
  const eighth = page.locator(".period-card").filter({ hasText: "8면학" });
  await expect(eighth).toContainText("남은 자리 4/10");

  periodFailure = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await expect(eighth).toContainText("남은 자리 4/10");
  await expect(eighth.getByRole("button", { name: "8면학 예약" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "다시 불러오기" })).toBeVisible();

  periodFailure = false;
  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(eighth.getByRole("button", { name: "8면학 예약" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "다시 불러오기" })).toHaveCount(0);

  const evidenceDir = requiredEvidenceDir();
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.screenshot({ fullPage: true, path: path.join(evidenceDir, "final-f3-student-desktop-1440x900.png") });
  await page.setViewportSize({ height: 844, width: 390 });
  await page.screenshot({ fullPage: true, path: path.join(evidenceDir, "final-f3-student-mobile-390x844.png") });
});

test("pending reserve preserves its input and cannot POST while freshness is stale", async ({ page }) => {
  let currentUser: SessionUser | null = null;
  let periodFailure = false;
  let holdRecovery = false;
  let recoveryPeriodRequests = 0;
  let recoverySessionRequests = 0;
  let reservationPosts = 0;
  let releaseRecovery = (): void => undefined;
  const recoveryGate = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  await page.route("**/api/me", async (route) => {
    if (holdRecovery) {
      recoverySessionRequests += 1;
      await recoveryGate;
    }
    await route.fulfill({ json: { user: currentUser }, status: 200 });
  });
  await installLoginAndStudentRoutes(page, (user) => {
    currentUser = user;
  });
  await page.route("**/api/periods**", async (route) => {
    if (periodFailure) {
      await route.fulfill({ json: { error: { message: "temporary" } }, status: 500 });
      return;
    }
    if (holdRecovery) {
      recoveryPeriodRequests += 1;
      await recoveryGate;
    }
    await fulfillPeriods(route, 4);
  });
  await page.route("**/api/reservations", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    reservationPosts += 1;
    await route.fulfill({ json: { reservation: { id: "reservation-new" } }, status: 201 });
  });

  await login(page, "pending-student");
  await page.locator(".period-card").filter({ hasText: "8면학" }).getByRole("button", { name: "8면학 예약" }).click();
  const reasonInput = page.getByPlaceholder("이용 사유를 직접 입력");
  await reasonInput.fill("수행평가 준비");

  periodFailure = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator(".topbar .refresh-status").getByRole("button", { name: "다시 불러오기" })).toBeVisible();
  await page.getByRole("button", { name: "신청하기" }).click();

  expect(reservationPosts).toBe(0);
  await expect(page.getByRole("dialog", { name: "8면학 예약할까요?" })).toBeVisible();
  await expect(reasonInput).toHaveValue("수행평가 준비");
  await expect(page.getByText("최신 정보를 다시 불러온 뒤 확인해주세요.")).toBeVisible();

  periodFailure = false;
  holdRecovery = true;
  const dialog = page.getByRole("dialog", { name: "8면학 예약할까요?" });
  const dialogRetry = dialog.getByRole("button", { name: "다시 불러오기" });
  await dialogRetry.click();
  await expect.poll(() => recoverySessionRequests).toBe(1);
  await expect.poll(() => recoveryPeriodRequests).toBe(1);
  await expect(dialogRetry).toBeDisabled();
  await expect(dialogRetry).toHaveAttribute("aria-busy", "true");
  await expect(dialogRetry).toHaveText("다시 불러오는 중");
  const pageRetry = page.locator(".topbar").getByRole("button", { name: "다시 불러오는 중" });
  await expect(pageRetry).toBeDisabled();
  await expect(pageRetry).toHaveAttribute("aria-busy", "true");
  await expect(pageRetry).toHaveText("다시 불러오는 중");
  await expect(dialog).toBeVisible();
  await expect(reasonInput).toHaveValue("수행평가 준비");

  holdRecovery = false;
  releaseRecovery();
  await expect(page.getByRole("button", { name: "다시 불러오기" })).toHaveCount(0);
  expect(recoverySessionRequests).toBe(1);
  expect(recoveryPeriodRequests).toBe(1);
  await expect(dialog.getByRole("button", { name: "신청하기" })).toBeFocused();
  await expect(reasonInput).toHaveValue("수행평가 준비");
  await page.getByRole("button", { name: "신청하기" }).click();
  await expect.poll(() => reservationPosts).toBe(1);
});

test("held CSRF cannot POST a confirmed reserve after period freshness becomes stale", async ({ page }) => {
  let currentUser: SessionUser | null = null;
  let periodFailure = false;
  let reservationPosts = 0;
  let markCsrfStarted = (): void => undefined;
  let releaseCsrf = (): void => undefined;
  const csrfStarted = new Promise<void>((resolve) => {
    markCsrfStarted = resolve;
  });
  const csrfGate = new Promise<void>((resolve) => {
    releaseCsrf = resolve;
  });
  await installBaseRoutes(page, () => currentUser, (user) => {
    currentUser = user;
  });
  await page.unroute("**/api/csrf");
  await page.route("**/api/csrf", async (route) => {
    markCsrfStarted();
    await csrfGate;
    await route.fulfill({ json: { csrfToken: "held-reserve-csrf" }, status: 200 });
  });
  await page.route("**/api/periods**", async (route) => {
    if (periodFailure) {
      await route.fulfill({ json: { error: { message: "temporary" } }, status: 500 });
      return;
    }
    await fulfillPeriods(route, 4);
  });
  await page.route("**/api/reservations", async (route) => {
    if (route.request().method() === "POST") {
      reservationPosts += 1;
    }
    await route.fulfill({ json: { reservation: { id: "reservation-new" } }, status: 201 });
  });

  await login(page, "held-reserve-student");
  await page.locator(".period-card").filter({ hasText: "8면학" }).getByRole("button", { name: "8면학 예약" }).click();
  const reasonInput = page.getByPlaceholder("이용 사유를 직접 입력");
  await reasonInput.fill("CSRF 대기 중 권한 변경 검증");
  await page.getByRole("button", { name: "신청하기" }).click();
  await csrfStarted;

  periodFailure = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator(".topbar .refresh-status").getByRole("button", { name: "다시 불러오기" })).toBeVisible();
  releaseCsrf();

  await expect(page.getByText("최신 정보를 다시 불러온 뒤 확인해주세요.")).toBeVisible();
  expect(reservationPosts).toBe(0);
  await expect(page.getByRole("dialog", { name: "8면학 예약할까요?" })).toBeVisible();
  await expect(reasonInput).toHaveValue("CSRF 대기 중 권한 변경 검증");
});

test("reserve and cancel await the coordinated week and session refresh before settled success", async ({ page }) => {
  const serverRestrictedUntil = "2026-06-30T03:15:00.000Z";
  let currentUser: SessionUser | null = null;
  let reservationId: string | null = null;
  let phase: "cancel" | "idle" | "reserve" = "idle";
  let reservePeriodRequests = 0;
  let reserveSessionRequests = 0;
  let cancelPeriodRequests = 0;
  let cancelSessionRequests = 0;
  const reservePeriodGate = deferred<void>();
  const reserveSessionGate = deferred<void>();
  const cancelPeriodGate = deferred<void>();
  const cancelSessionGate = deferred<void>();

  await page.route("**/api/me", async (route) => {
    if (phase === "reserve") {
      reserveSessionRequests += 1;
      await reserveSessionGate.promise;
    } else if (phase === "cancel") {
      cancelSessionRequests += 1;
      await cancelSessionGate.promise;
    }
    await route.fulfill({ json: { user: currentUser }, status: 200 });
  });
  await installLoginAndStudentRoutes(page, (user) => {
    currentUser = user;
  });
  await page.route("**/api/periods**", async (route) => {
    if (phase === "reserve") {
      reservePeriodRequests += 1;
      await reservePeriodGate.promise;
    } else if (phase === "cancel") {
      cancelPeriodRequests += 1;
      await cancelPeriodGate.promise;
    }
    await fulfillPeriods(route, reservationId ? 3 : 4, reservationId);
  });
  await page.route("**/api/reservations", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    reservationId = "reservation-new";
    phase = "reserve";
    await route.fulfill({ json: { reservation: { id: reservationId } }, status: 201 });
  });
  await page.route("**/api/reservations/*", async (route) => {
    reservationId = null;
    if (currentUser) {
      currentUser = {
        ...currentUser,
        bookingStatus: "RESTRICTED",
        restrictionReason: "예약 취소",
        restrictedUntil: serverRestrictedUntil
      };
    }
    phase = "cancel";
    await route.fulfill({ status: 204 });
  });

  await login(page, "coordinated-student");
  const eighth = page.locator(".period-card").filter({ hasText: "8면학" });
  await eighth.getByRole("button", { name: "8면학 예약" }).click();
  await page.getByPlaceholder("이용 사유를 직접 입력").fill("상태 동기화 검증");
  await page.getByRole("button", { name: "신청하기" }).click();
  await expect.poll(() => ({ reservePeriodRequests, reserveSessionRequests })).toEqual({
    reservePeriodRequests: 1,
    reserveSessionRequests: 1
  });
  await expect(page.getByText("예약이 확정되었습니다.")).toHaveCount(0);

  reservePeriodGate.resolve();
  await expect(page.getByText("예약이 확정되었습니다.")).toHaveCount(0);
  reserveSessionGate.resolve();
  await expect(page.getByText("예약이 확정되었습니다.")).toBeVisible();
  await expect(eighth.getByRole("button", { name: "예약 취소" })).toBeVisible();

  await eighth.getByRole("button", { name: "예약 취소" }).click();
  await page.getByLabel("정말 취소하려면 이 확인란을 선택하세요.").check();
  await page.getByRole("button", { name: "취소 확정" }).click();
  await expect.poll(() => ({ cancelPeriodRequests, cancelSessionRequests })).toEqual({
    cancelPeriodRequests: 1,
    cancelSessionRequests: 1
  });
  await expect(page.getByText("예약이 취소되었습니다. 3일간 예약이 제한됩니다.")).toHaveCount(0);

  cancelPeriodGate.resolve();
  await expect(page.getByText("예약이 취소되었습니다. 3일간 예약이 제한됩니다.")).toHaveCount(0);
  cancelSessionGate.resolve();
  await expect(page.getByText("예약이 취소되었습니다. 3일간 예약이 제한됩니다.")).toBeVisible();
  await eighth.getByRole("button", { name: "8면학 예약" }).click();
  await expect(page.getByText("예약 이용이 제한되었습니다.")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "8면학 예약할까요?" })).toHaveCount(0);
  expect(reservePeriodRequests).toBe(1);
  expect(reserveSessionRequests).toBe(1);
  expect(cancelPeriodRequests).toBe(1);
  expect(cancelSessionRequests).toBe(1);
});

test("failed post-cancel week refresh preserves visible data and never emits settled success", async ({ page }) => {
  let currentUser: SessionUser | null = null;
  let cancelSettled = false;
  let failedWeekRequests = 0;
  let mutationSessionRequests = 0;
  await page.route("**/api/me", async (route) => {
    if (cancelSettled) {
      mutationSessionRequests += 1;
    }
    await route.fulfill({ json: { user: currentUser }, status: 200 });
  });
  await installLoginAndStudentRoutes(page, (user) => {
    currentUser = user;
  });
  await page.route("**/api/periods**", async (route) => {
    if (cancelSettled) {
      failedWeekRequests += 1;
      await route.fulfill({ json: { error: { message: "temporary" } }, status: 500 });
      return;
    }
    await fulfillPeriods(route, 3, "reservation-a");
  });
  await page.route("**/api/reservations/*", async (route) => {
    if (currentUser) {
      currentUser = {
        ...currentUser,
        bookingStatus: "RESTRICTED",
        restrictionReason: "예약 취소",
        restrictedUntil: "2026-06-30T03:15:00.000Z"
      };
    }
    cancelSettled = true;
    await route.fulfill({ status: 204 });
  });

  await login(page, "failed-cancel-refresh");
  const eighth = page.locator(".period-card").filter({ hasText: "8면학" });
  await eighth.getByRole("button", { name: "예약 취소" }).click();
  await page.getByLabel("정말 취소하려면 이 확인란을 선택하세요.").check();
  await page.getByRole("button", { name: "취소 확정" }).click();

  await expect(page.getByText("예약은 취소되었지만 최신 정보를 불러오지 못했습니다.")).toBeVisible();
  await expect(page.getByText("예약이 취소되었습니다. 3일간 예약이 제한됩니다.")).toHaveCount(0);
  await expect(eighth).toContainText("남은 자리 3/10");
  await expect(eighth.getByRole("button", { name: "예약 취소" })).toBeDisabled();
  expect(failedWeekRequests).toBe(1);
  expect(mutationSessionRequests).toBe(1);
});

test("held CSRF cannot DELETE a confirmed cancellation after session freshness becomes stale", async ({ page }) => {
  let currentUser: SessionUser | null = null;
  let sessionFailure = false;
  let reservationDeletes = 0;
  let markCsrfStarted = (): void => undefined;
  let releaseCsrf = (): void => undefined;
  const csrfStarted = new Promise<void>((resolve) => {
    markCsrfStarted = resolve;
  });
  const csrfGate = new Promise<void>((resolve) => {
    releaseCsrf = resolve;
  });
  await page.route("**/api/me", async (route) => {
    if (sessionFailure) {
      await route.abort("failed");
      return;
    }
    await route.fulfill({ json: { user: currentUser }, status: 200 });
  });
  await installLoginAndStudentRoutes(page, (user) => {
    currentUser = user;
  });
  await page.unroute("**/api/csrf");
  await page.route("**/api/csrf", async (route) => {
    markCsrfStarted();
    await csrfGate;
    await route.fulfill({ json: { csrfToken: "held-cancel-csrf" }, status: 200 });
  });
  await page.route("**/api/periods**", (route) => fulfillPeriods(route, 4, "reservation-a"));
  await page.route("**/api/reservations/*", async (route) => {
    if (route.request().method() === "DELETE") {
      reservationDeletes += 1;
    }
    await route.fulfill({ status: 204 });
  });

  await login(page, "held-cancel-student");
  const eighth = page.locator(".period-card").filter({ hasText: "8면학" });
  await eighth.getByRole("button", { name: "예약 취소" }).click();
  const confirmation = page.getByLabel("정말 취소하려면 이 확인란을 선택하세요.");
  await confirmation.check();
  await page.getByRole("button", { name: "취소 확정" }).click();
  await csrfStarted;

  sessionFailure = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator(".topbar .refresh-status").getByRole("button", { name: "다시 불러오기" })).toBeVisible();
  releaseCsrf();

  await expect(page.getByText("최신 정보를 다시 불러온 뒤 확인해주세요.")).toBeVisible();
  expect(reservationDeletes).toBe(0);
  await expect(page.getByRole("dialog", { name: "예약을 취소할까요?" })).toBeVisible();
  await expect(confirmation).toBeChecked();
});

test("owner change during reservation preflight cannot open a dialog or POST", async ({ page }) => {
  const userB = studentUser("student-b");
  let currentUser: SessionUser | null = null;
  let holdStudentAWeekRequest = false;
  let swapOwnerOnNextSessionRead = false;
  let reservationPosts = 0;
  let markWeekRequestStarted = (): void => undefined;
  let releaseOldWeekRequest = (): void => undefined;
  const weekRequestStarted = new Promise<void>((resolve) => {
    markWeekRequestStarted = resolve;
  });
  const oldWeekRequestGate = new Promise<void>((resolve) => {
    releaseOldWeekRequest = resolve;
  });

  await page.route("**/api/me", async (route) => {
    if (swapOwnerOnNextSessionRead) {
      currentUser = userB;
      swapOwnerOnNextSessionRead = false;
    }
    await route.fulfill({ json: { user: currentUser }, status: 200 });
  });
  await installLoginAndStudentRoutes(page, (user) => {
    currentUser = user;
  });
  await page.route("**/api/periods**", async (route) => {
    const url = new URL(route.request().url());
    if (holdStudentAWeekRequest && url.searchParams.has("weekStart") && currentUser?.id === "student-a") {
      holdStudentAWeekRequest = false;
      markWeekRequestStarted();
      await oldWeekRequestGate;
    }
    await fulfillPeriods(route, currentUser?.id === userB.id ? 7 : 2);
  });
  await page.route("**/api/reservations", async (route) => {
    if (route.request().method() === "POST") {
      reservationPosts += 1;
    }
    await route.fulfill({ json: {}, status: 201 });
  });

  await login(page, "student-a");
  holdStudentAWeekRequest = true;
  await page.locator(".period-card").filter({ hasText: "8면학" }).getByRole("button", { name: "8면학 예약" }).click();
  await weekRequestStarted;

  swapOwnerOnNextSessionRead = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("student-b", { exact: true })).toBeVisible();
  releaseOldWeekRequest();

  await expect(page.getByRole("dialog", { name: "8면학 예약할까요?" })).toHaveCount(0);
  expect(reservationPosts).toBe(0);
});

test("transient session failure retains identity while 401 clears it", async ({ page }) => {
  let currentUser: SessionUser | null = null;
  let sessionMode: "ok" | "network" | "unauthorized" = "ok";
  await page.route("**/api/me", async (route) => {
    if (sessionMode === "network") {
      await route.abort("failed");
      return;
    }
    if (sessionMode === "unauthorized") {
      await route.fulfill({ json: { error: { message: "로그인이 필요합니다." } }, status: 401 });
      return;
    }
    await route.fulfill({ json: { user: currentUser }, status: 200 });
  });
  await installLoginAndStudentRoutes(page, (user) => {
    currentUser = user;
  });
  await page.route("**/api/periods**", (route) => fulfillPeriods(route, 3));

  await login(page, "session-student");
  await expect(page.getByText("session-student", { exact: true })).toBeVisible();

  sessionMode = "network";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("session-student", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "다시 불러오기" })).toBeVisible();

  sessionMode = "unauthorized";
  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(page.getByRole("button", { name: "인증하기" })).toBeVisible();
  await expect(page.getByText("session-student", { exact: true })).toHaveCount(0);
});

test("changed-user transition never renders held prior-owner profile, notification, or period responses", async ({ page }) => {
  const userA = studentUser("student-a");
  const userB = studentUser("student-b");
  let currentUser: SessionUser | null = null;
  let nextSessionUser: SessionUser | null = null;
  let holdOldResources = false;
  let releaseOldResources = (): void => undefined;
  const oldResourceGate = new Promise<void>((resolve) => {
    releaseOldResources = resolve;
  });

  await page.route("**/api/me", async (route) => {
    if (nextSessionUser) {
      currentUser = nextSessionUser;
      nextSessionUser = null;
    }
    await route.fulfill({ json: { user: currentUser }, status: 200 });
  });
  await installLoginRoute(page, (user) => {
    currentUser = userA.id === user.id ? userA : user;
  });
  await page.route("**/api/periods**", async (route) => {
    const ownerAtRequest = currentUser?.id;
    if (holdOldResources && ownerAtRequest === userA.id) {
      await oldResourceGate;
    }
    await fulfillPeriods(route, ownerAtRequest === userA.id ? 2 : 7);
  });
  await page.route("**/api/me/profile", async (route) => {
    const ownerAtRequest = currentUser;
    if (holdOldResources && ownerAtRequest?.id === userA.id) {
      await oldResourceGate;
    }
    await route.fulfill({ json: profilePayload(ownerAtRequest ?? userB), status: 200 });
  });
  await page.route("**/api/me/notifications", async (route) => {
    const ownerAtRequest = currentUser;
    if (holdOldResources && ownerAtRequest?.id === userA.id) {
      await oldResourceGate;
    }
    await route.fulfill({ json: notificationPayload(ownerAtRequest ?? userB), status: 200 });
  });
  await page.route("**/api/csrf", (route) => route.fulfill({ json: { csrfToken: "refresh-csrf" }, status: 200 }));

  await login(page, "student-a");
  await page.getByRole("button", { name: "프로필", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "프로필" })).toContainText("student-a profile");
  await page.getByRole("button", { name: "닫기" }).click();
  await page.getByRole("button", { name: "학생 알림 열기" }).click();
  await expect(page.getByText("student-a notification", { exact: true })).toBeVisible();

  holdOldResources = true;
  await page.getByRole("button", { name: "프로필", exact: true }).click();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  nextSessionUser = userB;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("student-b", { exact: true })).toBeVisible();
  await expect(page.getByText("student-a notification", { exact: true })).toHaveCount(0);
  await expect(page.getByText("student-a profile", { exact: true })).toHaveCount(0);

  releaseOldResources();
  holdOldResources = false;
  await page.getByRole("button", { name: "학생 알림 열기" }).click();
  await expect(page.getByText("student-b notification", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "프로필", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "프로필" })).toContainText("student-b profile");
  await expect(page.locator(".period-card").first()).toContainText("남은 자리 7/10");
});

async function installBaseRoutes(
  page: Page,
  getCurrentUser: () => SessionUser | null,
  setCurrentUser: (user: SessionUser) => void
): Promise<void> {
  await page.route("**/api/me", (route) => route.fulfill({ json: { user: getCurrentUser() }, status: 200 }));
  await installLoginAndStudentRoutes(page, setCurrentUser);
}

async function installLoginAndStudentRoutes(page: Page, setCurrentUser: (user: SessionUser) => void): Promise<void> {
  await installLoginRoute(page, setCurrentUser);
  await page.route("**/api/me/profile", (route) => route.fulfill({ json: profilePayload(studentUser("student")), status: 200 }));
  await page.route("**/api/me/notifications", (route) => route.fulfill({ json: { notifications: [] }, status: 200 }));
  await page.route("**/api/csrf", (route) => route.fulfill({ json: { csrfToken: "refresh-csrf" }, status: 200 }));
}

async function installLoginRoute(page: Page, setCurrentUser: (user: SessionUser) => void): Promise<void> {
  await page.route("**/api/auth/riro/login", async (route) => {
    const body = parseLoginRequestBody(route.request().postData());
    if (!body) {
      await route.fulfill({ json: { error: { message: "잘못된 로그인 요청입니다." } }, status: 400 });
      return;
    }
    const user = studentUser(body.id);
    setCurrentUser(user);
    await route.fulfill({ json: { user }, status: 200 });
  });
}

function parseLoginRequestBody(rawBody: string | null): { readonly id: string } | null {
  if (rawBody === null) {
    return null;
  }
  try {
    const payload: unknown = JSON.parse(rawBody);
    const parsed = LoginRequestSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function login(page: Page, id: string): Promise<void> {
  await mockClientDate(page, e2eNow(FIXED_THURSDAY_DATE));
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.getByLabel("리로스쿨 ID").fill(id);
  await page.getByLabel("리로스쿨 PW").fill("password");
  await page.getByRole("button", { name: "인증하기" }).click();
  await expect(page.locator(".period-card")).toHaveCount(2);
}

async function fulfillPeriods(route: Route, remaining: number, reservationId: string | null = null): Promise<void> {
  const url = new URL(route.request().url());
  const weekStart = url.searchParams.get("weekStart");
  if (weekStart) {
    await route.fulfill({
      headers: { ETag: `"remaining-${remaining}"` },
      json: {
        dates: SCHOOL_WEEK_DATES.map((date) => ({
          date,
          periods: [
            weekPeriod("EIGHTH", remaining, date === FIXED_THURSDAY_DATE ? reservationId : null),
            weekPeriod("FIRST", remaining, null)
          ]
        }))
      },
      status: 200
    });
    return;
  }
  const date = url.searchParams.get("date") ?? FIXED_THURSDAY_DATE;
  await route.fulfill({
    json: {
      periods: [
        datePeriod(date, "EIGHTH", "8면학", remaining, reservationId),
        datePeriod(date, "FIRST", "1면학", remaining, null)
      ]
    },
    status: 200
  });
}

function studentUser(id: string): SessionUser {
  return {
    bookingStatus: "ACTIVE" as const,
    generation: 10,
    id,
    name: id,
    restrictionReason: null,
    restrictedUntil: null,
    role: "STUDENT" as const,
    studentNumber: id === "student-b" ? "32002" : "32001"
  };
}

function weekPeriod(
  studyPeriod: "EIGHTH" | "FIRST",
  availability: number,
  reservationId: string | null
): StudentPeriodWeekPeriod {
  return {
    availability,
    capacity: 10,
    closeTime: "23:59",
    enabled: true,
    myReservationId: reservationId,
    openTime: "00:00",
    reservedCount: 10 - availability,
    studyPeriod
  };
}

function datePeriod(
  date: string,
  studyPeriod: "EIGHTH" | "FIRST",
  label: string,
  remaining: number,
  reservationId: string | null
): StudentPeriodSummary {
  return {
    capacity: 10,
    closeTime: "23:59",
    confirmedCount: 10 - remaining,
    date,
    enabled: true,
    label,
    myReservationId: reservationId,
    openTime: "00:00",
    remaining,
    studyPeriod,
    windowState: "open"
  };
}

function profilePayload(user: SessionUser): RefreshProfilePayload {
  return {
    currentReservations: [],
    effectiveStatus: "ACTIVE",
    recentReservations: [],
    recentSanctions: [],
    reservationSummary: { cancelledCount: 0, confirmedCount: 0, noShowCount: 0 },
    sanctionSummary: { activeCount: 0, permanentCount: 0, revokedCount: 0, totalCount: 0 },
    statusMessage: "예약 가능",
    user: { ...user, name: `${user.id} profile` }
  };
}

function notificationPayload(user: SessionUser): RefreshNotificationPayload {
  return {
    notifications: [{
      createdAt: "2026-06-11T04:00:00.000Z",
      id: `${user.id}-notification`,
      message: `${user.id} notification`,
      reason: null,
      title: "알림"
    }]
  };
}

function requiredEvidenceDir(): string {
  const value = process.env.EVIDENCE_DIR;
  if (!value) {
    throw new Error("EVIDENCE_DIR is required for final student screenshots.");
  }
  return value;
}

function deferred<Value>() {
  let resolvePromise: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
