import { expect, test, type APIResponse, type Page, type Response } from "@playwright/test";
import { z } from "zod";

import { csrfRequest } from "./playwright-csrf";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const DATE = "2026-08-10";
const TARGET_ID = "discord-target-outside-general-cap";
const NOW = "2026-08-09T12:00:00.000Z";

const LoginResponseSchema = z.object({
  user: z.object({
    name: z.string().min(1),
    studentNumber: z.string().min(1)
  })
});

const AdminPeriodSettingSchema = z.object({
  capacity: z.number().int().positive(),
  closeTime: z.string().regex(/^\d{2}:\d{2}$/u),
  enabled: z.boolean(),
  openTime: z.string().regex(/^\d{2}:\d{2}$/u),
  studyPeriod: z.union([z.literal("EIGHTH"), z.literal("FIRST")])
});

const AdminPeriodSettingsPayloadSchema = z.object({
  periods: z.array(AdminPeriodSettingSchema)
});

const ServerPeriodSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)
});

const ServerTodayPayloadSchema = z.object({
  periods: z.tuple([ServerPeriodSchema]).rest(ServerPeriodSchema)
});

const AdminCreateReservationPayloadSchema = z.object({
  reservation: z.object({
    id: z.string().min(1)
  })
});

const CancellationErrorPayloadSchema = z.object({
  error: z.object({
    code: z.string().max(128),
    message: z.string().max(512)
  })
});

const ExactReservationPayloadSchema = z.object({
  reservations: z.array(
    z.object({
      date: z.string(),
      id: z.string(),
      status: z.string(),
      user: z.object({ studentNumber: z.string() })
    })
  )
});

type AdminPeriodSetting = z.infer<typeof AdminPeriodSettingSchema>;

type AdminMockState = {
  authenticated: boolean;
  cancelPosts: number;
  exactReads: number;
  exactTargetAvailable: boolean;
};

test("loopback root deep link reads and cancels a real confirmed reservation exactly once", async ({ page }) => {
  test.skip(!isLoopbackUrl(BASE_URL), "real deep-link smoke only runs against a loopback app");

  const adminCredentials = {
    id: firstEnvValue(process.env.E2E_ADMIN_LOGIN_ID) ?? firstEnvValue(process.env.ADMIN_LOGIN_ID) ?? "admin",
    password:
      firstEnvValue(process.env.E2E_ADMIN_LOGIN_PASSWORD) ?? firstEnvValue(process.env.ADMIN_LOGIN_PASSWORD) ?? "password"
  };
  const studentCredentials = { id: `deep-link-${crypto.randomUUID()}`, password: "password" };
  let adminLoggedIn = false;
  let periodSettingsToRestore: { readonly date: string; readonly periods: readonly AdminPeriodSetting[] } | null = null;
  let reservationId: string | null = null;
  let reservationCancelled = false;

  try {
    const studentLogin = await loginWithApi(page, studentCredentials);
    const studentLoginUser = LoginResponseSchema.parse(await studentLogin.json()).user;
    const studentName = studentLoginUser.name;
    const studentNumber = studentLoginUser.studentNumber;
    const date = await fetchServerKstToday(page);
    await logout(page);

    await loginAsAdmin(page, adminCredentials);
    adminLoggedIn = true;
    const originalPeriods = await fetchPeriodSettings(page, date);
    periodSettingsToRestore = { date, periods: originalPeriods };
    await patchPeriodSettings(
      page,
      date,
      originalPeriods.map((period) =>
        period.studyPeriod === "EIGHTH"
          ? { ...period, closeTime: "23:59", enabled: true, openTime: "00:00" }
          : period
      )
    );

    const createResponse = await csrfRequest(page, "/api/admin/reservations", {
      json: {
        date,
        reason: "Todo 6 deep-link real API coverage",
        studentNumber,
        studyPeriod: "EIGHTH"
      },
      method: "POST"
    });
    expect(createResponse.status()).toBe(201);
    const createdId = AdminCreateReservationPayloadSchema.parse(await createResponse.json()).reservation.id;
    reservationId = createdId;

    let cancellationPosts = 0;
    const cancellationPath = `/api/admin/reservations/${createdId}/cancel`;
    const isCancellationRequest = (request: { readonly method: () => string; readonly url: () => string }): boolean =>
      request.method() === "POST" && new URL(request.url()).pathname === cancellationPath;
    page.on("request", (request) => {
      if (isCancellationRequest(request)) {
        cancellationPosts += 1;
      }
    });

    const exactRead = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        url.pathname === "/api/admin/reservations" &&
        url.searchParams.get("date") === date &&
        url.searchParams.get("reservationId") === createdId &&
        url.searchParams.get("status") === "CONFIRMED"
      );
    });

    await page.goto(realDeepLinkUrl(date, createdId));

    const exactReadResponse = await exactRead;
    expect(exactReadResponse.status()).toBe(200);
    expect(exactReadResponse.headers()["cache-control"]).toBe("no-store");
    expect(ExactReservationPayloadSchema.parse(await exactReadResponse.json()).reservations).toEqual([
      expect.objectContaining({
        date,
        id: createdId,
        status: "CONFIRMED",
        user: expect.objectContaining({ studentNumber })
      })
    ]);

    const dialog = page.getByRole("dialog", { name: "예약을 관리자 취소할까요?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(studentName);
    expect(cancellationPosts).toBe(0);

    const cancellationRequest = page.waitForRequest(isCancellationRequest);
    const cancellationResponse = page.waitForResponse((response) => isCancellationRequest(response.request()));
    await dialog.getByLabel("취소 사유").fill("Todo 6 deep-link cancellation");
    await dialog.getByRole("button", { name: "취소 확정" }).click();

    const observedCancellationRequest = await cancellationRequest;
    const observedCancellationHeaders = await observedCancellationRequest.allHeaders();
    expect(observedCancellationHeaders["x-csrf-token"]).toBeTruthy();
    expect(observedCancellationHeaders["origin"]).toBe(new URL(BASE_URL).origin);
    const observedCancellationResponse = await cancellationResponse;
    expect(
      observedCancellationResponse.status(),
      await cancellationResponseDiagnostic(observedCancellationResponse)
    ).toBe(200);
    reservationCancelled = true;
    expect(cancellationPosts).toBe(1);
    await expect(dialog).toHaveCount(0);
  } finally {
    try {
      if (reservationId !== null && !reservationCancelled) {
        await loginAsAdmin(page, adminCredentials);
        adminLoggedIn = true;
        const cleanupResponse = await csrfRequest(page, `/api/admin/reservations/${reservationId}/cancel`, {
          json: { reason: "Todo 6 failed-test cleanup" },
          method: "POST"
        });
        expect([200, 404, 409]).toContain(cleanupResponse.status());
      }
    } finally {
      try {
        if (periodSettingsToRestore !== null) {
          await loginAsAdmin(page, adminCredentials);
          adminLoggedIn = true;
          await patchPeriodSettings(page, periodSettingsToRestore.date, periodSettingsToRestore.periods);
        }
      } finally {
        if (adminLoggedIn) {
          await logout(page);
        }
      }
    }
  }
});

test("unauthenticated root deep link keeps its tuple through login and opens the exact cancellation dialog", async ({ page }) => {
  // Given
  const state = adminMockState({ authenticated: false, exactTargetAvailable: true });
  await mockDeepLinkAdmin(page, state);
  const url = deepLinkUrl("source=discord&campaign=ops");

  // When
  await page.goto(url);
  await expect(page).toHaveURL(url);
  await page.getByLabel("리로스쿨 ID").fill("admin");
  await page.getByLabel("리로스쿨 PW").fill("password");
  await page.getByRole("button", { name: "인증하기" }).click();

  // Then
  const dialog = page.getByRole("dialog", { name: "예약을 관리자 취소할까요?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("딥링크학생");
  await expect(page).toHaveURL(new RegExp(`\\?source=discord&campaign=ops&section=reservations&date=${DATE}&status=CONFIRMED$`));
  expect(state.exactReads).toBeGreaterThanOrEqual(1);
  expect(state.cancelPosts).toBe(0);
});

test("invalid and cancelled root targets show one safe message and apply exact controlled-key cleanup", async ({ page }) => {
  // Given
  const state = adminMockState({ authenticated: true, exactTargetAvailable: false });
  await mockDeepLinkAdmin(page, state);

  // When: partial tuple
  await page.goto(`${BASE_URL}/?source=discord&section=reservations&date=${DATE}&status=CONFIRMED&tag=a&tag=b`);

  // Then: every controlled key is removed, unrelated duplicates remain, and no exact read runs
  await expect(page.getByText("예약 링크가 올바르지 않습니다.")).toHaveCount(1);
  await expect(page).toHaveURL(`${BASE_URL}/?source=discord&tag=a&tag=b`);
  expect(state.exactReads).toBe(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // When: syntactically valid but cancelled/missing target
  await page.goto(deepLinkUrl("source=discord&tag=a&tag=b"));

  // Then: only reservation is removed and no destructive target is opened
  await expect(page.getByText("해당 확정 예약을 찾을 수 없습니다.")).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`\\?source=discord&tag=a&tag=b&section=reservations&date=${DATE}&status=CONFIRMED$`));
  expect(state.exactReads).toBeGreaterThanOrEqual(1);
  expect(state.cancelPosts).toBe(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

function adminMockState(input: Pick<AdminMockState, "authenticated" | "exactTargetAvailable">): AdminMockState {
  return { ...input, cancelPosts: 0, exactReads: 0 };
}

async function mockDeepLinkAdmin(page: Page, state: AdminMockState): Promise<void> {
  await page.route("**/api/me", (route) => route.fulfill({ json: { user: state.authenticated ? adminUser() : null } }));
  await page.route("**/api/auth/riro/login", async (route) => {
    state.authenticated = true;
    await route.fulfill({ json: { user: adminUser() } });
  });
  await page.route("**/api/csrf", (route) => route.fulfill({ json: { csrfToken: "deep-link-csrf" } }));
  await page.route("**/api/admin/reservations**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/admin/reservations/${TARGET_ID}/cancel`) {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers()["x-csrf-token"]).toBe("deep-link-csrf");
      state.cancelPosts += 1;
      await route.fulfill({ json: { reservation: mutationReservation("CANCELLED") } });
      return;
    }
    if (url.pathname === "/api/admin/reservations") {
      if (url.searchParams.get("reservationId") === TARGET_ID) {
        state.exactReads += 1;
        expect(url.searchParams.get("date")).toBe(DATE);
        expect(url.searchParams.get("status")).toBe("CONFIRMED");
        await route.fulfill({ json: { reservations: state.exactTargetAvailable ? [targetReservation()] : [] } });
        return;
      }
      await route.fulfill({ json: { reservations: [] } });
      return;
    }
  });
  await page.route("**/api/admin/period-settings**", (route) => route.fulfill({ json: { periods: [] } }));
  await page.route("**/api/admin/notification-settings**", (route) =>
    route.fulfill({
      json: {
        notificationSettings: {
          closedPeriodNotificationsEnabled: true,
          id: "global",
          reservationCreatedNotificationsEnabled: true
        }
      }
    })
  );
}

function deepLinkUrl(prefix: string): string {
  return `${BASE_URL}/?${prefix}&section=reservations&date=${DATE}&status=CONFIRMED&reservation=${TARGET_ID}`;
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
    studentNumber: "0"
  };
}

function targetReservation(): object {
  return {
    createdAt: NOW,
    date: DATE,
    id: TARGET_ID,
    reason: "학습",
    status: "CONFIRMED",
    studyPeriod: "EIGHTH",
    user: {
      bookingStatus: "ACTIVE",
      id: "deep-link-student",
      name: "딥링크학생",
      role: "STUDENT",
      studentNumber: "29999"
    }
  };
}

function mutationReservation(status: string): object {
  return {
    createdAt: NOW,
    date: DATE,
    id: TARGET_ID,
    reason: "학습",
    status,
    studyPeriod: "EIGHTH",
    updatedAt: NOW,
    userId: "deep-link-student"
  };
}

async function cancellationResponseDiagnostic(response: Response): Promise<string> {
  if (response.status() === 200) {
    return "cancellation response status was 200";
  }

  const responseBody = new TextDecoder().decode(await response.body());
  let responseJson: unknown;
  try {
    responseJson = JSON.parse(responseBody);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return `cancellation response status was ${response.status()} with no safe error payload`;
    }
    throw error;
  }
  const payload = CancellationErrorPayloadSchema.safeParse(responseJson);
  if (!payload.success) {
    return `cancellation response status was ${response.status()} with no safe error payload`;
  }

  return `cancellation response status was ${response.status()}: ${payload.data.error.code} — ${payload.data.error.message}`;
}

function realDeepLinkUrl(date: string, reservationId: string): string {
  const parameters = new URLSearchParams({
    date,
    reservation: reservationId,
    section: "reservations",
    source: "discord",
    status: "CONFIRMED"
  });
  return `${BASE_URL}/?${parameters.toString()}`;
}

async function loginWithApi(
  page: Page,
  credentials: { readonly id: string; readonly password: string }
): Promise<APIResponse> {
  const response = await page.request.post(`${BASE_URL}/api/auth/riro/login`, {
    data: credentials,
    headers: { "x-forwarded-for": nextTestIp() }
  });
  if (!response.ok()) {
    throw new Error(`Login failed with ${response.status()}: ${await response.text()}`);
  }
  return response;
}

async function loginAsAdmin(
  page: Page,
  credentials: { readonly id: string; readonly password: string }
): Promise<void> {
  await loginWithApi(page, credentials);
}

async function logout(page: Page): Promise<void> {
  const response = await csrfRequest(page, "/api/auth/logout", { method: "POST" });
  expect(response.status()).toBe(200);
}

async function fetchPeriodSettings(page: Page, date: string): Promise<readonly AdminPeriodSetting[]> {
  const response = await page.request.get(`${BASE_URL}/api/admin/period-settings?date=${date}`);
  expect(response.status()).toBe(200);
  return AdminPeriodSettingsPayloadSchema.parse(await response.json()).periods;
}

async function fetchServerKstToday(page: Page): Promise<string> {
  const response = await page.request.get(`${BASE_URL}/api/periods`);
  expect(response.status()).toBe(200);
  return ServerTodayPayloadSchema.parse(await response.json()).periods[0].date;
}

async function patchPeriodSettings(
  page: Page,
  date: string,
  periods: readonly AdminPeriodSetting[]
): Promise<void> {
  const response = await csrfRequest(page, "/api/admin/period-settings", {
    json: { date, periods },
    method: "PATCH"
  });
  expect(response.status()).toBe(200);
}

function firstEnvValue(value: string | undefined): string | null {
  const first = value?.split(",")[0]?.trim().replace(/^"|"$/gu, "");
  return first ? first : null;
}

function isLoopbackUrl(value: string): boolean {
  const { hostname } = new URL(value);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

let testIpCounter = 0;

function nextTestIp(): string {
  testIpCounter += 1;
  return `198.51.211.${(testIpCounter % 250) + 1}`;
}
