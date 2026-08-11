import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RateLimitResult } from "@/lib/rate-limit";
import type { CurrentSession, SessionUser } from "@/lib/session";

type UserRow = {
  readonly bookingStatus: string;
  readonly id: string;
  readonly restrictedUntil: Date | null;
  readonly role: string;
};

type ReservationRow = {
  readonly date: string;
  readonly id: string;
  readonly reason: string;
  readonly status: string;
  readonly studyPeriod: "EIGHTH";
  readonly userId: string;
};

type DatabaseActor = { readonly id: string | null; readonly role: "ADMIN" | "STUDENT" | "SYSTEM" };
type UserFindUnique = (input: unknown) => Promise<UserRow | null>;
type ContextInput = {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: ContextTransaction) => Promise<unknown>;
};
type MutationInput = ContextInput & { readonly lockKeys: readonly string[] };
type ContextTransaction = {
  readonly user: { readonly findUnique: UserFindUnique };
};

const routeMocks = vi.hoisted(() => ({
  adminActionCreate: vi.fn<(input: unknown) => Promise<{ readonly id: string }>>(),
  auditLogCreate: vi.fn<(input: unknown) => Promise<unknown>>(),
  contextUserFindUnique: vi.fn<UserFindUnique>(),
  enforceAdminMutationRateLimit:
    vi.fn<(request: Request, userId: string) => Promise<RateLimitResult>>(),
  mutationUserFindUnique: vi.fn<UserFindUnique>(),
  periodSettingFindMany: vi.fn<(input: unknown) => Promise<readonly unknown[]>>(),
  rawUserFindUnique: vi.fn<UserFindUnique>(),
  requireAdminSession: vi.fn<() => Promise<CurrentSession>>(),
  reservationCount: vi.fn<(input: unknown) => Promise<number>>(),
  reservationCreate: vi.fn<(input: unknown) => Promise<ReservationRow>>(),
  reservationFindUnique: vi.fn<(input: unknown) => Promise<ReservationRow | null>>(),
  validateRequestCsrf: vi.fn<() => Promise<{ readonly kind: "ok" }>>(),
  withDatabaseContext: vi.fn<(input: ContextInput) => Promise<unknown>>(),
  withDatabaseMutation: vi.fn<(input: MutationInput) => Promise<unknown>>()
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: routeMocks.rawUserFindUnique }
  }
}));

vi.mock("@/lib/db-context", () => ({
  TransactionRetryExhaustedError: class TransactionRetryExhaustedError extends Error {},
  databaseActorFromSessionUser: (user: { readonly id: string; readonly role: string }): DatabaseActor => ({
    id: user.id,
    role: user.role === "ADMIN" ? "ADMIN" : "STUDENT"
  }),
  periodMutationLockKey: (date: string, studyPeriod: string): string => `period:${date}:${studyPeriod}`,
  userMutationLockKey: (userId: string): string => `user:${userId}`,
  withDatabaseContext: routeMocks.withDatabaseContext,
  withDatabaseMutation: routeMocks.withDatabaseMutation
}));

vi.mock("@/lib/mock-dev-mode", () => ({ isNoDatabaseMockMode: () => false }));
vi.mock("@/lib/request-csrf", () => ({
  messageForCsrfError: (reason: string) => reason,
  validateRequestCsrf: routeMocks.validateRequestCsrf
}));
vi.mock("@/lib/request-security", () => ({ requireMutatingRequestSafety: () => null }));
vi.mock("@/lib/route-rate-limit", () => ({
  enforceAdminMutationRateLimit: routeMocks.enforceAdminMutationRateLimit
}));
vi.mock("@/lib/session", () => ({
  ForbiddenSessionError: class ForbiddenSessionError extends Error {},
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {},
  requireAdminSession: routeMocks.requireAdminSession
}));

import { POST } from "./admin-create-reservation";

const adminUser: SessionUser = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "admin-actor-1",
  name: "관리자",
  restrictionReason: null,
  restrictedUntil: null,
  role: "ADMIN",
  studentNumber: "90000"
};

const targetUser = {
  bookingStatus: "ACTIVE",
  id: "student-target-1",
  restrictedUntil: null,
  role: "STUDENT"
} satisfies UserRow;

const createdReservation = {
  date: "2026-06-16",
  id: "reservation-created",
  reason: "관리자 수동 추가",
  status: "CONFIRMED",
  studyPeriod: "EIGHTH",
  userId: targetUser.id
} satisfies ReservationRow;

describe("admin reservation target lookup actor context", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T05:00:00.000Z"));
    vi.resetAllMocks();

    routeMocks.requireAdminSession.mockResolvedValue({ id: "session-admin", user: adminUser });
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    routeMocks.enforceAdminMutationRateLimit.mockResolvedValue(allowedRateLimit());
    routeMocks.rawUserFindUnique.mockResolvedValue(targetUser);
    routeMocks.contextUserFindUnique.mockResolvedValue(targetUser);
    routeMocks.mutationUserFindUnique.mockResolvedValue(targetUser);
    routeMocks.periodSettingFindMany.mockResolvedValue([
      {
        capacity: 10,
        closeTime: "23:59",
        date: "2026-06-16",
        enabled: true,
        openTime: "00:00",
        studyPeriod: "EIGHTH"
      }
    ]);
    routeMocks.reservationFindUnique.mockResolvedValue(null);
    routeMocks.reservationCount.mockResolvedValue(0);
    routeMocks.reservationCreate.mockResolvedValue(createdReservation);
    routeMocks.adminActionCreate.mockResolvedValue({ id: "action-create" });
    routeMocks.auditLogCreate.mockResolvedValue({});
    routeMocks.withDatabaseContext.mockImplementation(async (input) =>
      input.operation({ user: { findUnique: routeMocks.contextUserFindUnique } })
    );
    routeMocks.withDatabaseMutation.mockImplementation(async (input) =>
      input.operation(mutationTransaction())
    );
  });

  it("uses the exact authenticated ADMIN actor and no raw protected User read when the student exists", async () => {
    const response = await POST(createRequest("25001"));

    expect(routeMocks.withDatabaseContext).toHaveBeenCalledWith({
      actor: { id: adminUser.id, role: "ADMIN" },
      client: expect.any(Object),
      operation: expect.any(Function)
    });
    expect(routeMocks.contextUserFindUnique).toHaveBeenCalledWith({
      select: { id: true, role: true },
      where: { studentNumber: "25001" }
    });
    expect(routeMocks.rawUserFindUnique).not.toHaveBeenCalled();
    expect(routeMocks.withDatabaseMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { id: adminUser.id, role: "ADMIN" },
        lockKeys: ["period:2026-06-16:EIGHTH", `user:${targetUser.id}`]
      })
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ reservation: createdReservation });
  });

  it("returns not-found with no writes when the contextual ADMIN lookup cannot find the student", async () => {
    routeMocks.contextUserFindUnique.mockResolvedValue(null);
    routeMocks.rawUserFindUnique.mockResolvedValue(null);

    const response = await POST(createRequest("99999"));

    expect(routeMocks.withDatabaseContext).toHaveBeenCalledOnce();
    expect(routeMocks.rawUserFindUnique).not.toHaveBeenCalled();
    expect(routeMocks.withDatabaseMutation).not.toHaveBeenCalled();
    expect(routeMocks.reservationCreate).not.toHaveBeenCalled();
    expect(routeMocks.adminActionCreate).not.toHaveBeenCalled();
    expect(routeMocks.auditLogCreate).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "등록된 학생을 찾을 수 없습니다." }
    });
  });

  it("preserves confirmed creation writes after the contextual lookup", async () => {
    const response = await POST(createRequest("25001"));

    expect(routeMocks.reservationCreate).toHaveBeenCalledWith({
      data: {
        date: "2026-06-16",
        reason: "관리자 수동 추가",
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        userId: targetUser.id
      }
    });
    expect(routeMocks.adminActionCreate).toHaveBeenCalledOnce();
    expect(routeMocks.auditLogCreate).toHaveBeenCalledOnce();
    expect(response.status).toBe(201);
  });

  it("preserves duplicate conflict behavior after the contextual lookup", async () => {
    routeMocks.reservationFindUnique.mockResolvedValue(createdReservation);

    const response = await POST(createRequest("25001"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "duplicate", message: "이미 예약된 시간대입니다." }
    });
    expect(routeMocks.reservationCreate).not.toHaveBeenCalled();
    expect(routeMocks.adminActionCreate).not.toHaveBeenCalled();
    expect(routeMocks.auditLogCreate).not.toHaveBeenCalled();
  });
});

function mutationTransaction() {
  return {
    adminAction: { create: routeMocks.adminActionCreate },
    auditLog: { create: routeMocks.auditLogCreate },
    periodSetting: { findMany: routeMocks.periodSettingFindMany },
    reservation: {
      count: routeMocks.reservationCount,
      create: routeMocks.reservationCreate,
      findUnique: routeMocks.reservationFindUnique
    },
    user: { findUnique: routeMocks.mutationUserFindUnique }
  };
}

function createRequest(studentNumber: string): Request {
  return new Request("https://example.test/api/admin/reservations", {
    body: JSON.stringify({
      date: "2026-06-16",
      reason: "관리자 수동 추가",
      studentNumber,
      studyPeriod: "EIGHTH"
    }),
    headers: {
      "content-type": "application/json",
      "x-csrf-token": "csrf-token",
      origin: "https://example.test"
    },
    method: "POST"
  });
}

function allowedRateLimit(): RateLimitResult {
  return {
    kind: "allowed",
    remaining: 9,
    resetAt: new Date("2026-06-16T05:01:00.000Z")
  };
}
