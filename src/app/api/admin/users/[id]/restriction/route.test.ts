import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TransactionRetryExhaustedError } from "@/lib/db-context";
import type { RateLimitResult } from "@/lib/rate-limit";
import type { CurrentSession, SessionUser } from "@/lib/session";

type UserRow = {
  readonly bookingStatus: string;
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly restrictedUntil: Date | null;
  readonly restrictionReason: string | null;
  readonly role: string;
  readonly shadowBanProfile: string;
  readonly studentNumber: string;
};
type UserFindUnique = (input: unknown) => Promise<UserRow | null>;
type UserUpdate = (input: unknown) => Promise<UserRow>;
type ReservationUpdateMany = (input: unknown) => Promise<{ readonly count: number }>;
type AdminActionCreate = (input: unknown) => Promise<{ readonly id: string }>;
type AuditLogCreate = (input: unknown) => Promise<unknown>;
type UserSanctionCreate = (input: unknown) => Promise<unknown>;
type UserSanctionUpdateMany = (input: unknown) => Promise<unknown>;
type TransactionClient = {
  readonly $executeRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<number>;
  readonly adminAction: { readonly create: AdminActionCreate };
  readonly auditLog: { readonly create: AuditLogCreate };
  readonly reservation: { readonly updateMany: ReservationUpdateMany };
  readonly user: { readonly findUnique: UserFindUnique; readonly update: UserUpdate };
  readonly userSanction: {
    readonly create: UserSanctionCreate;
    readonly updateMany: UserSanctionUpdateMany;
  };
};
type PrismaTransaction = <T>(operation: (transaction: TransactionClient) => Promise<T>) => Promise<T>;
type RequireAdminSession = () => Promise<CurrentSession>;
type ValidateRequestCsrf = (request: Request, sessionId: string) => Promise<{ readonly kind: "ok" }>;

const routeMocks = vi.hoisted(() => ({
  adminActionCreate: vi.fn<AdminActionCreate>(),
  auditLogCreate: vi.fn<AuditLogCreate>(),
  enforceAdminMutationRateLimit: vi.fn<(request: Request, userId: string) => Promise<RateLimitResult>>(),
  isNoDatabaseMockMode: vi.fn<() => boolean>(),
  rawCalls: [] as Array<{ readonly strings: readonly string[]; readonly values: readonly unknown[] }>,
  requireAdminSession: vi.fn<RequireAdminSession>(),
  requireMutatingRequestSafety: vi.fn<(request: Request) => null>(),
  reservationUpdateMany: vi.fn<ReservationUpdateMany>(),
  targetFindUnique: vi.fn<UserFindUnique>(),
  transaction: vi.fn<PrismaTransaction>(),
  userSanctionCreate: vi.fn<UserSanctionCreate>(),
  userSanctionUpdateMany: vi.fn<UserSanctionUpdateMany>(),
  userUpdate: vi.fn<UserUpdate>(),
  validateRequestCsrf: vi.fn<ValidateRequestCsrf>()
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: routeMocks.transaction,
    user: { findUnique: routeMocks.targetFindUnique }
  }
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode
}));

vi.mock("@/lib/request-csrf", () => ({
  messageForCsrfError: (reason: string) => `csrf:${reason}`,
  validateRequestCsrf: routeMocks.validateRequestCsrf
}));

vi.mock("@/lib/request-security", () => ({
  requireMutatingRequestSafety: routeMocks.requireMutatingRequestSafety
}));

vi.mock("@/lib/route-rate-limit", () => ({
  enforceAdminMutationRateLimit: routeMocks.enforceAdminMutationRateLimit
}));

vi.mock("@/lib/session", () => ({
  ForbiddenSessionError: class ForbiddenSessionError extends Error {},
  requireAdminSession: routeMocks.requireAdminSession,
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {}
}));

import { DELETE, POST } from "./route";

const adminUser: SessionUser = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "admin-1",
  name: "관리자",
  restrictionReason: null,
  restrictedUntil: null,
  role: "ADMIN",
  shadowBanProfile: "NORMAL",
  studentNumber: "90000"
};

const targetUser = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "student-1",
  name: "김학생",
  restrictedUntil: null,
  restrictionReason: null,
  role: "STUDENT",
  shadowBanProfile: "NORMAL",
  studentNumber: "31001"
} satisfies UserRow;

const allowedRateLimit: RateLimitResult = {
  kind: "allowed",
  remaining: 9,
  resetAt: new Date("2026-06-16T00:01:00.000Z")
};

describe("admin user restriction route", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T04:30:00.000Z"));
    vi.resetAllMocks();
    routeMocks.rawCalls.length = 0;

    routeMocks.requireMutatingRequestSafety.mockReturnValue(null);
    routeMocks.requireAdminSession.mockResolvedValue({ id: "session-admin", user: adminUser });
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    routeMocks.enforceAdminMutationRateLimit.mockResolvedValue(allowedRateLimit);
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.targetFindUnique.mockResolvedValue(targetUser);
    routeMocks.userUpdate.mockImplementation(async (input) => {
      const patch = (input as { readonly data: Partial<UserRow> }).data;
      return { ...targetUser, ...patch };
    });
    routeMocks.reservationUpdateMany.mockResolvedValue({ count: 2 });
    routeMocks.adminActionCreate.mockResolvedValue({ id: "action-restrict" });
    routeMocks.userSanctionUpdateMany.mockResolvedValue({});
    routeMocks.userSanctionCreate.mockResolvedValue({});
    routeMocks.auditLogCreate.mockResolvedValue({});
    routeMocks.transaction.mockImplementation(async (operation) => operation(transactionClient()));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-cancels current and future confirmed reservations when applying a hard ban", async () => {
    const response = await POST(
      restrictionRequest({ days: null, reason: "차단", status: "BANNED" }),
      restrictionContext(targetUser.id)
    );

    expect(response.status).toBe(200);
    expect(routeMocks.reservationUpdateMany).toHaveBeenCalledWith({
      data: { status: "CANCELLED" },
      where: {
        date: { gte: "2026-06-16" },
        status: "CONFIRMED",
        userId: targetUser.id
      }
    });
    const auditLogInput = routeMocks.auditLogCreate.mock.calls[0]?.[0] as { readonly data: { readonly detail: string } };
    expect(JSON.parse(auditLogInput.data.detail)).toMatchObject({
      cancelledFutureReservationCount: 2,
      status: "BANNED"
    });
    const lockValues = routeMocks.rawCalls
      .filter((call) => call.strings.join("?").includes("pg_advisory_xact_lock"))
      .map((call) => call.values);
    expect(lockValues).toEqual([[`user:${targetUser.id}`]]);
  });

  it("keeps current and future reservations when applying a shadow ban", async () => {
    const response = await POST(
      restrictionRequest({ days: null, reason: "블랙리스트", status: "SHADOW_BANNED" }),
      restrictionContext(targetUser.id)
    );

    expect(response.status).toBe(200);
    expect(routeMocks.reservationUpdateMany).not.toHaveBeenCalled();
    const auditLogInput = routeMocks.auditLogCreate.mock.calls[0]?.[0] as { readonly data: { readonly detail: string } };
    expect(JSON.parse(auditLogInput.data.detail)).toMatchObject({
      cancelledFutureReservationCount: 0,
      status: "SHADOW_BANNED"
    });
  });

  it("stores the selected shadow-ban profile when applying a shadow ban", async () => {
    const response = await POST(
      restrictionRequest({ days: null, reason: "블랙리스트", shadowBanProfile: "HIGH", status: "SHADOW_BANNED" }),
      restrictionContext(targetUser.id)
    );

    expect(response.status).toBe(200);
    expect(routeMocks.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bookingStatus: "SHADOW_BANNED",
          shadowBanProfile: "HIGH"
        })
      })
    );
    const auditLogInput = routeMocks.auditLogCreate.mock.calls[0]?.[0] as { readonly data: { readonly detail: string } };
    expect(JSON.parse(auditLogInput.data.detail)).toMatchObject({
      shadowBanProfile: "HIGH",
      status: "SHADOW_BANNED"
    });
  });

  it("keeps existing reservations when applying a temporary restriction", async () => {
    const response = await POST(
      restrictionRequest({ days: 3, reason: "예약 취소 반복", status: "RESTRICTED" }),
      restrictionContext(targetUser.id)
    );

    expect(response.status).toBe(200);
    expect(routeMocks.reservationUpdateMany).not.toHaveBeenCalled();
  });

  it("does not overwrite an existing hard ban with a weaker restriction", async () => {
    routeMocks.targetFindUnique.mockResolvedValue({
      ...targetUser,
      bookingStatus: "BANNED",
      restrictionReason: "노쇼"
    });

    const response = await POST(
      restrictionRequest({ days: 3, reason: "예약 취소 반복", status: "RESTRICTED" }),
      restrictionContext(targetUser.id)
    );

    expect(response.status).toBe(409);
    expect(routeMocks.userUpdate).not.toHaveBeenCalled();
    expect(routeMocks.adminActionCreate).not.toHaveBeenCalled();
  });

  it("serializes explicit restriction removal on the target user", async () => {
    const response = await DELETE(restrictionRequest(undefined, "DELETE"), restrictionContext(targetUser.id));

    expect(response.status).toBe(200);
    const lockValues = routeMocks.rawCalls
      .filter((call) => call.strings.join("?").includes("pg_advisory_xact_lock"))
      .map((call) => call.values);
    expect(lockValues).toEqual([[`user:${targetUser.id}`]]);
  });

  it("returns a retryable 503 when restriction serialization is exhausted", async () => {
    routeMocks.transaction.mockRejectedValueOnce(new TransactionRetryExhaustedError(new Error("P2034")));

    const response = await POST(
      restrictionRequest({ days: null, reason: "차단", status: "BANNED" }),
      restrictionContext(targetUser.id)
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
  });
});

function transactionClient(): TransactionClient {
  return {
    async $executeRaw(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<number> {
      routeMocks.rawCalls.push({ strings: [...strings], values });
      return 1;
    },
    adminAction: { create: routeMocks.adminActionCreate },
    auditLog: { create: routeMocks.auditLogCreate },
    reservation: { updateMany: routeMocks.reservationUpdateMany },
    user: { findUnique: routeMocks.targetFindUnique, update: routeMocks.userUpdate },
    userSanction: {
      create: routeMocks.userSanctionCreate,
      updateMany: routeMocks.userSanctionUpdateMany
    }
  };
}

function restrictionRequest(body: unknown, method = "POST"): Request {
  const init = {
    headers: {
      "content-type": "application/json",
      "x-csrf-token": "csrf-token",
      origin: "https://example.test"
    },
    method
  } satisfies RequestInit;
  return new Request(
    `https://example.test/api/admin/users/${targetUser.id}/restriction`,
    body === undefined ? init : { ...init, body: JSON.stringify(body) }
  );
}

function restrictionContext(userId: string): { readonly params: Promise<{ readonly id: string }> } {
  return { params: Promise.resolve({ id: userId }) };
}
