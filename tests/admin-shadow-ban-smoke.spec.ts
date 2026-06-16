import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { z } from "zod";

import { csrfRequest } from "./playwright-csrf";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const CAN_READ_LOCAL_LOGIN_ENV = isLoopbackUrl(BASE_URL) || process.env.E2E_ALLOW_LOCAL_LOGIN_ENV === "true";
const ADMIN_LOGIN_ID =
  firstEnvValue(process.env.E2E_ADMIN_LOGIN_ID) ?? localEnvValue(process.env.ADMIN_LOGIN_ID) ?? "admin";
const ADMIN_LOGIN_PASSWORD =
  firstEnvValue(process.env.E2E_ADMIN_LOGIN_PASSWORD) ??
  localEnvValue(process.env.ADMIN_LOGIN_PASSWORD) ??
  "password";
const STUDENT_LOGIN_ID =
  firstEnvValue(process.env.E2E_STUDENT_LOGIN_ID) ?? localEnvValue(process.env.LOCAL_STUDENT_LOGIN_ID);
const STUDENT_LOGIN_PASSWORD =
  firstEnvValue(process.env.E2E_STUDENT_LOGIN_PASSWORD) ??
  localEnvValue(process.env.LOCAL_STUDENT_LOGIN_PASSWORD) ??
  "password";
const STUDENT_NUMBER =
  firstEnvValue(process.env.E2E_STUDENT_NUMBER) ?? localEnvValue(process.env.LOCAL_STUDENT_NUMBER);
const BLACKLIST_REASON = "블랙리스트";

const AdminUserSchema = z.object({
  bookingStatus: z.string(),
  id: z.string(),
  restrictionReason: z.string().nullable(),
  studentNumber: z.string()
});

const AdminUsersPayloadSchema = z.object({
  users: z.array(AdminUserSchema)
});

type AdminUser = z.infer<typeof AdminUserSchema>;

test("admin can shadow-ban, verify masked student APIs, and release through live APIs", async ({ page }) => {
  test.skip(!isLoopbackUrl(BASE_URL), "admin shadow-ban smoke only runs against a loopback app");

  const loginId = STUDENT_LOGIN_ID ?? `shadow-smoke-${Date.now()}`;
  const studentNumber = STUDENT_NUMBER ?? expectedMockStudentNumber(loginId);
  let targetUserId: string | null = null;

  await loginWithApi(page, { id: loginId, password: STUDENT_LOGIN_PASSWORD });
  await logout(page);
  await loginWithApi(page, { id: ADMIN_LOGIN_ID, password: ADMIN_LOGIN_PASSWORD });

  try {
    const target = await findAdminUser(page, { query: studentNumber, status: "ALL" });
    targetUserId = target.id;

    const applyResponse = await csrfRequest(page, `/api/admin/users/${target.id}/restriction`, {
      json: { days: null, reason: BLACKLIST_REASON, status: "SHADOW_BANNED" },
      method: "POST"
    });
    expect(applyResponse.status()).toBe(200);

    const shadowBannedUser = await findAdminUser(page, { query: studentNumber, status: "SHADOW_BANNED" });
    expect(shadowBannedUser).toMatchObject({
      bookingStatus: "SHADOW_BANNED",
      restrictionReason: BLACKLIST_REASON,
      studentNumber
    });

    await logout(page);
    const loginResponse = await loginWithApi(page, { id: loginId, password: STUDENT_LOGIN_PASSWORD });
    await expectMaskedStudentResponse(loginResponse, { expectEffectiveStatus: false });
    await expectMaskedStudentResponse(await page.request.get(`${BASE_URL}/api/me`), {
      expectEffectiveStatus: false
    });
    await expectMaskedStudentResponse(await page.request.get(`${BASE_URL}/api/me/profile`), {
      expectEffectiveStatus: true
    });

    await logout(page);
    await loginWithApi(page, { id: ADMIN_LOGIN_ID, password: ADMIN_LOGIN_PASSWORD });
    const releaseResponse = await csrfRequest(page, `/api/admin/users/${target.id}/restriction`, { method: "DELETE" });
    expect(releaseResponse.status()).toBe(200);
    targetUserId = null;

    const releasedUser = await findAdminUser(page, { query: studentNumber, status: "ALL" });
    expect(releasedUser).toMatchObject({
      bookingStatus: "ACTIVE",
      restrictionReason: null,
      studentNumber
    });
  } finally {
    if (targetUserId !== null) {
      await loginWithApi(page, { id: ADMIN_LOGIN_ID, password: ADMIN_LOGIN_PASSWORD });
      await csrfRequest(page, `/api/admin/users/${targetUserId}/restriction`, { method: "DELETE" });
    }
  }
});

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

async function logout(page: Page): Promise<void> {
  await csrfRequest(page, "/api/auth/logout", { method: "POST" });
}

async function findAdminUser(
  page: Page,
  input: { readonly query: string; readonly status: string }
): Promise<AdminUser> {
  const params = new URLSearchParams({ bookingStatus: input.status, query: input.query });
  const response = await page.request.get(`${BASE_URL}/api/admin/users?${params.toString()}`);
  expect(response.ok()).toBeTruthy();
  const payload = AdminUsersPayloadSchema.parse(await response.json());
  const user = payload.users.find((candidate) => candidate.studentNumber === input.query);
  if (user === undefined) {
    throw new Error(`Admin user ${input.query} was not returned for status ${input.status}.`);
  }
  return user;
}

async function expectMaskedStudentResponse(
  response: APIResponse,
  options: { readonly expectEffectiveStatus: boolean }
): Promise<void> {
  expect(response.ok()).toBeTruthy();
  const text = await response.text();
  expect(text).not.toContain("SHADOW_BANNED");
  expect(text).not.toContain(BLACKLIST_REASON);
  expect(text).toContain('"bookingStatus":"ACTIVE"');
  expect(text).toContain('"restrictionReason":null');
  expect(text).toContain('"restrictedUntil":null');
  if (options.expectEffectiveStatus) {
    expect(text).toContain('"effectiveStatus":"ACTIVE"');
  }
}

function expectedMockStudentNumber(loginId: string): string {
  const digits = loginId.replace(/\D/gu, "");
  return digits.length >= 4 ? digits.slice(-5) : `9${digits.padStart(4, "0")}`;
}

function firstEnvValue(value: string | undefined): string | null {
  const first = value?.split(",")[0]?.trim().replace(/^"|"$/gu, "");
  return first ? first : null;
}

function localEnvValue(value: string | undefined): string | null {
  return CAN_READ_LOCAL_LOGIN_ENV ? firstEnvValue(value) : null;
}

function isLoopbackUrl(value: string): boolean {
  const { hostname } = new URL(value);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

let testIpCounter = 0;

function nextTestIp(): string {
  testIpCounter += 1;
  return `198.51.210.${(testIpCounter % 250) + 1}`;
}
