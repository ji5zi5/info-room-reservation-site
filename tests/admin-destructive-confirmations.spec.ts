import { expect, test, type Page, type Route } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const NOW = "2026-06-16T12:00:00.000Z";
const RESERVATION_ID = "reservation-confirmed";
const STUDENT_ID = "student-1";

type MutationState = {
  cancelAttempts: number;
  noShowAttempts: number;
  restrictionAttempts: number;
  readonly responses: {
    cancel: readonly MockResponse[];
    noShow: readonly MockResponse[];
    restriction: readonly MockResponse[];
  };
  releaseAttempts: number;
  shadowBanAttempts: number;
  userIsBanned: boolean;
};

type MockResponse = {
  readonly body: object;
  readonly status: number;
};

test("administrator cancellation focuses its reason, does not post before confirmation, and keeps a 409 reason ready to retry", async ({ page }) => {
  test.skip(!isLoopbackUrl(BASE_URL), "local admin harness only runs against a loopback app");

  const state = mutationState({
    cancel: [errorResponse(409, "이미 처리된 예약입니다."), cancelSuccessResponse()]
  });
  await mockAdminConsole(page, state);
  await openReservations(page);
  const reservationRow = page.locator(".table-list .table-line").filter({ hasText: "테스트학생" }).filter({ hasText: "25001" });

  await reservationRow.getByRole("button", { exact: true, name: "취소" }).click();
  const dialog = page.getByRole("dialog", { name: "예약을 관리자 취소할까요?" });
  const reason = dialog.getByLabel("취소 사유");
  await expect(dialog).toBeVisible();
  await expect(reason).toBeFocused();
  expect(state.cancelAttempts).toBe(0);

  await reason.fill("운영상 취소");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(state.cancelAttempts).toBe(0);

  await reservationRow.getByRole("button", { exact: true, name: "취소" }).click();
  await page.getByRole("dialog", { name: "예약을 관리자 취소할까요?" }).getByLabel("취소 사유").fill("운영상 취소");
  await page.getByRole("button", { name: "취소 확정" }).click();
  await expect.poll(() => state.cancelAttempts).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(reason).toHaveValue("운영상 취소");

  await page.getByRole("button", { name: "취소 확정" }).click();
  await expect.poll(() => state.cancelAttempts).toBe(2);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("예약을 관리자 취소 처리했습니다.")).toBeVisible();
  await reservationRow.getByRole("button", { exact: true, name: "취소" }).click();
  await expect(page.getByRole("dialog", { name: "예약을 관리자 취소할까요?" }).getByLabel("취소 사유")).toHaveValue("");
});

test("reservation-list no-show has safe initial focus, blocks every pending dismissal, posts once, and reports the authoritative future-cancellation count", async ({ page }) => {
  test.skip(!isLoopbackUrl(BASE_URL), "local admin harness only runs against a loopback app");

  const state = mutationState({ noShow: [noShowSuccessResponse(2)] });
  const gate = createGate();
  await mockAdminConsole(page, state, { noShowGate: gate.promise });
  await openReservations(page);
  const reservationRow = page.locator(".table-list .table-line").filter({ hasText: "테스트학생" }).filter({ hasText: "25001" });

  await reservationRow.getByRole("button", { name: "노쇼" }).click();
  const dialog = page.getByRole("dialog", { name: "노쇼로 처리할까요?" });
  const back = dialog.getByRole("button", { name: "돌아가기" });
  await expect(dialog).toContainText("노쇼 처리하면 학생은 영구 제한됩니다.");
  await expect(back).toBeFocused();
  expect(state.noShowAttempts).toBe(0);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(state.noShowAttempts).toBe(0);

  await reservationRow.getByRole("button", { name: "노쇼" }).click();
  await page.locator(".confirm-backdrop").click({ position: { x: 2, y: 2 } });
  await expect(dialog).toHaveCount(0);
  expect(state.noShowAttempts).toBe(0);

  await reservationRow.getByRole("button", { name: "노쇼" }).click();
  await page.getByRole("button", { name: "닫기" }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.noShowAttempts).toBe(0);

  await reservationRow.getByRole("button", { name: "노쇼" }).click();
  await dialog.getByRole("button", { name: "돌아가기" }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.noShowAttempts).toBe(0);

  await reservationRow.getByRole("button", { name: "노쇼" }).click();
  const confirm = dialog.locator("button.danger-button");
  await confirm.dblclick();
  await expect.poll(() => state.noShowAttempts).toBe(1);
  await expect(confirm).toHaveText("처리 중…");
  await expect(confirm).toBeDisabled();
  await expect(back).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.locator(".confirm-backdrop").click({ position: { x: 2, y: 2 } });
  await page.getByRole("button", { name: "닫기" }).click({ force: true });
  await back.click({ force: true });
  await expect(dialog).toBeVisible();

  gate.release();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("향후 확정 예약 2건을 취소했습니다.")).toBeVisible();
});

test("student-detail no-show uses the same confirmation before posting", async ({ page }) => {
  test.skip(!isLoopbackUrl(BASE_URL), "local admin harness only runs against a loopback app");

  const state = mutationState({ noShow: [noShowSuccessResponse(1)] });
  await mockAdminConsole(page, state);
  await openStudentDetail(page);

  const detail = page.locator(".student-detail-panel[data-open='true']");
  await detail.getByRole("button", { name: "노쇼" }).click();
  const dialog = page.getByRole("dialog", { name: "노쇼로 처리할까요?" });
  await expect(dialog.getByRole("button", { name: "돌아가기" })).toBeFocused();
  expect(state.noShowAttempts).toBe(0);

  await dialog.getByRole("button", { name: "노쇼 처리" }).click();
  await expect.poll(() => state.noShowAttempts).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("향후 확정 예약 1건을 취소했습니다.")).toBeVisible();
});

test("hard-ban confirmation preserves the chosen reason after a 503, retries once, and leaves ordinary restriction, shadow-ban, and release direct", async ({ page }) => {
  test.skip(!isLoopbackUrl(BASE_URL), "local admin harness only runs against a loopback app");

  const state = mutationState({
    restriction: [errorResponse(503, "제재 적용에 실패했습니다."), restrictionSuccessResponse(3)]
  });
  await mockAdminConsole(page, state);
  await openStudentDetail(page);

  const detail = page.locator(".student-detail-panel[data-open='true']");
  const reason = detail.getByLabel("제재 사유");
  await reason.fill("반복 노쇼");
  await detail.getByRole("group", { name: "제재 기간" }).getByRole("button", { name: "영구" }).click();
  await detail.getByRole("button", { name: "학생 제재 적용" }).click();
  const dialog = page.getByRole("dialog", { name: "영구 제한을 적용할까요?" });
  const back = dialog.getByRole("button", { name: "돌아가기" });
  await expect(dialog).toContainText("영구 제한하면 미래의 확정 예약이 취소됩니다.");
  await expect(back).toBeFocused();
  expect(state.restrictionAttempts).toBe(0);

  await dialog.getByRole("button", { name: "영구 제한 적용" }).click();
  await expect.poll(() => state.restrictionAttempts).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("반복 노쇼");
  await expect(reason).toHaveValue("반복 노쇼");

  await dialog.getByRole("button", { name: "영구 제한 적용" }).click();
  await expect.poll(() => state.restrictionAttempts).toBe(2);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("향후 확정 예약 3건을 취소했습니다.")).toBeVisible();

  await reason.fill("기간 제한");
  await detail.getByRole("group", { name: "제재 기간" }).getByRole("button", { name: "7일" }).click();
  await detail.getByRole("button", { name: "학생 제재 적용" }).click();
  await expect.poll(() => state.restrictionAttempts).toBe(3);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("학생 제재를 적용했습니다.", { exact: true })).toBeVisible();
  await expect(reason).toHaveValue("");

  await reason.fill("숨김 대상 사유");
  await detail.getByRole("group", { name: "제재 기간" }).getByRole("button", { name: "블랙리스트(숨김)" }).click();
  await detail.getByRole("button", { name: "학생 제재 적용" }).click();
  await expect.poll(() => state.shadowBanAttempts).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await detail.getByRole("button", { name: "제한 해제" }).click();
  await expect.poll(() => state.releaseAttempts).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

function mutationState(input: Partial<Record<"cancel" | "noShow" | "restriction", readonly MockResponse[]>>): MutationState {
  return {
    cancelAttempts: 0,
    noShowAttempts: 0,
    restrictionAttempts: 0,
    releaseAttempts: 0,
    responses: { cancel: input.cancel ?? [], noShow: input.noShow ?? [], restriction: input.restriction ?? [] },
    shadowBanAttempts: 0,
    userIsBanned: false
  };
}

async function mockAdminConsole(page: Page, state: MutationState, options?: { readonly noShowGate?: Promise<void> }): Promise<void> {
  await loginAsAdmin(page);
  await page.route("**/api/me", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { user: adminUser() } });
  });
  await page.route("**/api/csrf", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { csrfToken: "test-csrf-token" } });
  });
  await page.route("**/api/admin/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === `/api/admin/reservations/${RESERVATION_ID}/cancel`) {
      state.cancelAttempts += 1;
      await fulfillMutation(route, state.responses.cancel[state.cancelAttempts - 1] ?? cancelSuccessResponse());
      return;
    }
    if (pathname === `/api/admin/reservations/${RESERVATION_ID}/no-show`) {
      state.noShowAttempts += 1;
      await options?.noShowGate;
      await fulfillMutation(route, state.responses.noShow[state.noShowAttempts - 1] ?? noShowSuccessResponse(0));
      return;
    }
    if (pathname === `/api/admin/users/${STUDENT_ID}/restriction` && route.request().method() === "POST") {
      const payload: unknown = route.request().postDataJSON();
      if (isObject(payload) && payload.status === "SHADOW_BANNED") {
        state.shadowBanAttempts += 1;
        await fulfillMutation(route, restrictionSuccessResponse(0));
        return;
      }
      state.restrictionAttempts += 1;
      const response = state.responses.restriction[state.restrictionAttempts - 1] ?? restrictionSuccessResponse(0);
      if (response.status === 200) {
        state.userIsBanned = true;
      }
      await fulfillMutation(route, response);
      return;
    }
    if (pathname === `/api/admin/users/${STUDENT_ID}/restriction` && route.request().method() === "DELETE") {
      state.releaseAttempts += 1;
      state.userIsBanned = false;
      await fulfillMutation(route, { body: { user: restrictedUser() }, status: 200 });
      return;
    }
    await fulfillAdminRead(route, state);
  });
}

async function loginAsAdmin(page: Page): Promise<void> {
  const response = await page.request.post(`${BASE_URL}/api/auth/riro/login`, {
    data: localAdminCredentials(),
    headers: { "x-forwarded-for": nextTestIp() }
  });
  if (!response.ok()) {
    throw new Error(`Admin login failed with ${response.status()}: ${await response.text()}`);
  }
}

function localAdminCredentials(): { readonly id: string; readonly password: string } {
  return {
    id: firstEnvValue(process.env.E2E_ADMIN_LOGIN_ID) ?? firstEnvValue(process.env.ADMIN_LOGIN_ID) ?? "admin",
    password:
      firstEnvValue(process.env.E2E_ADMIN_LOGIN_PASSWORD) ?? firstEnvValue(process.env.ADMIN_LOGIN_PASSWORD) ?? "password"
  };
}

function firstEnvValue(value: string | undefined): string | null {
  const first = value?.split(",")[0]?.trim().replace(/^"|"$/gu, "");
  return first ? first : null;
}

function isLoopbackUrl(value: string): boolean {
  const { hostname } = new URL(value);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function adminRouteUrl(): string {
  const baseUrl = new URL(BASE_URL);
  return new URL("/admin", baseUrl.origin).toString();
}

let testIpCounter = 0;

function nextTestIp(): string {
  testIpCounter += 1;
  return `198.51.211.${(testIpCounter % 250) + 1}`;
}

async function openReservations(page: Page): Promise<void> {
  await page.goto(adminRouteUrl(), { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "예약자" }).click();
  await expect(page.getByText("테스트학생")).toBeVisible();
}

async function openStudentDetail(page: Page): Promise<void> {
  await page.goto(adminRouteUrl(), { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "학생" }).click();
  const student = page.locator(".user-line").filter({ hasText: "25001" });
  await student.getByRole("button", { name: "상세 보기" }).click();
  await expect(page.locator(".student-detail-panel[data-open='true']")).toBeVisible();
}

async function fulfillAdminRead(route: Route, state: MutationState): Promise<void> {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/api/admin/period-settings") {
    await route.fulfill({ contentType: "application/json", json: { periods: [] } });
    return;
  }
  if (pathname === "/api/admin/notification-settings") {
    await route.fulfill({ contentType: "application/json", json: { notificationSettings: notificationSettings() } });
    return;
  }
  if (pathname === "/api/admin/dashboard") {
    await route.fulfill({ contentType: "application/json", json: { notificationBacklog: [], periods: [] } });
    return;
  }
  if (pathname === "/api/admin/reservations") {
    await route.fulfill({ contentType: "application/json", json: { reservations: [reservationListRow()] } });
    return;
  }
  if (pathname === "/api/admin/statistics") {
    await route.fulfill({ contentType: "application/json", json: { statistics: null } });
    return;
  }
  if (pathname === "/api/admin/users") {
    await route.fulfill({ contentType: "application/json", json: { users: [studentUser()] } });
    return;
  }
  if (pathname === `/api/admin/users/${STUDENT_ID}`) {
    await route.fulfill({ contentType: "application/json", json: studentDetail(state.userIsBanned) });
    return;
  }
  if (pathname === "/api/admin/actions") {
    await route.fulfill({ contentType: "application/json", json: { actions: [] } });
    return;
  }
  await route.fulfill({
    contentType: "application/json",
    json: { error: { message: "Unexpected mocked admin route" } },
    status: 404
  });
}

async function fulfillMutation(route: Route, response: MockResponse): Promise<void> {
  await route.fulfill({ contentType: "application/json", json: response.body, status: response.status });
}

function cancelSuccessResponse(): MockResponse {
  return { body: { reservation: reservation("CANCELLED") }, status: 200 };
}

function noShowSuccessResponse(cancelledFutureReservationCount: number): MockResponse {
  return {
    body: { cancelledFutureReservationCount, reservation: reservation("NO_SHOW"), user: restrictedUser() },
    status: 200
  };
}

function restrictionSuccessResponse(cancelledFutureReservationCount: number): MockResponse {
  return { body: { cancelledFutureReservationCount, user: restrictedUser() }, status: 200 };
}

function errorResponse(status: number, message: string): MockResponse {
  return { body: { error: { message } }, status };
}

function adminUser(): object {
  return {
    bookingStatus: "ACTIVE",
    generation: 0,
    id: "admin-1",
    name: "관리자",
    restrictedUntil: null,
    restrictionReason: null,
    role: "ADMIN",
    shadowBanProfile: "NORMAL",
    studentNumber: "0"
  };
}

function studentUser(): object {
  return {
    bookingStatus: "ACTIVE",
    generation: 25,
    id: STUDENT_ID,
    name: "테스트학생",
    restrictedUntil: null,
    restrictionReason: null,
    role: "STUDENT",
    shadowBanProfile: "NORMAL",
    studentNumber: "25001"
  };
}

function restrictedUser(): object {
  return { ...studentUser(), bookingStatus: "BANNED", restrictionReason: "반복 노쇼" };
}

function reservation(status = "CONFIRMED"): object {
  return {
    createdAt: NOW,
    date: "2026-06-17",
    id: RESERVATION_ID,
    reason: "학습",
    status,
    studyPeriod: "EIGHTH",
    updatedAt: NOW,
    user: {
      bookingStatus: "ACTIVE",
      id: STUDENT_ID,
      name: "테스트학생",
      role: "STUDENT",
      studentNumber: "25001"
    },
    userId: STUDENT_ID
  };
}

function reservationListRow(): object {
  return {
    createdAt: NOW,
    date: "2026-06-17",
    id: RESERVATION_ID,
    reason: "학습",
    status: "CONFIRMED",
    studyPeriod: "EIGHTH",
    user: {
      bookingStatus: "ACTIVE",
      id: STUDENT_ID,
      name: "테스트학생",
      role: "STUDENT",
      studentNumber: "25001"
    }
  };
}

function studentDetail(userIsBanned: boolean): object {
  return {
    adminActions: [],
    auditLogs: [],
    currentReservations: [reservation()],
    reservationHistory: [],
    sanctions: [],
    sanctionSummary: { activeCount: 0, permanentCount: 0, revokedCount: 0, totalCount: 0 },
    sessionSummary: { activeCount: 0, expiredCount: 0, totalCount: 0 },
    summary: { cancelledCount: 0, confirmedCount: 1, noShowCount: 0 },
    user: { ...(userIsBanned ? restrictedUser() : studentUser()), createdAt: NOW, updatedAt: NOW }
  };
}

function notificationSettings(): object {
  return { closedPeriodNotificationsEnabled: true, id: "global", reservationCreatedNotificationsEnabled: false };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createGate(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release: () => {
      if (release === undefined) {
        throw new Error("The pending mutation gate was not initialized.");
      }
      release();
    }
  };
}
