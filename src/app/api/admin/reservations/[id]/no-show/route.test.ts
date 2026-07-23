import { beforeEach, describe, expect, it, vi } from "vitest";

import { TransactionRetryExhaustedError } from "@/lib/db-context";
import type { RateLimitResult } from "@/lib/rate-limit";
import type { CurrentSession, SessionUser } from "@/lib/session";

type ReservationRow = {
  readonly id: string;
  readonly status: string;
  readonly userId: string;
};

type UserRow = {
  readonly bookingStatus: string;
  readonly id: string;
  readonly restrictionReason: string | null;
  readonly restrictedUntil: Date | null;
  readonly role: string;
};

type Write = (input: unknown) => Promise<unknown>;
type TransactionClient = {
  readonly $executeRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<number>;
  readonly adminAction: { readonly create: (input: unknown) => Promise<{ readonly id: string }> };
  readonly auditLog: { readonly create: Write };
  readonly reservation: {
    readonly findUnique: (input: unknown) => Promise<ReservationRow | null>;
    readonly update: (input: unknown) => Promise<ReservationRow>;
    readonly updateMany: (input: unknown) => Promise<{ readonly count: number }>;
  };
  readonly user: {
    readonly findUnique: (input: unknown) => Promise<UserRow | null>;
    readonly update: (input: unknown) => Promise<UserRow>;
  };
  readonly userSanction: { readonly create: Write; readonly updateMany: Write };
};
type PrismaTransaction = <T>(operation: (transaction: TransactionClient) => Promise<T>) => Promise<T>;

const routeMocks = vi.hoisted(() => ({
  adminActionCreate: vi.fn<(input: unknown) => Promise<{ readonly id: string }>>(),
  auditLogCreate: vi.fn<Write>(),
  enforceAdminMutationRateLimit: vi.fn<(request: Request, userId: string) => Promise<RateLimitResult>>(),
  rawCalls: [] as Array<{ readonly strings: readonly string[]; readonly values: readonly unknown[] }>,
  requireAdminSession: vi.fn<() => Promise<CurrentSession>>(),
  requireMutatingRequestSafety: vi.fn<(request: Request) => null>(),
  reservationFindUnique: vi.fn<(input: unknown) => Promise<ReservationRow | null>>(),
  reservationUpdate: vi.fn<(input: unknown) => Promise<ReservationRow>>(),
  reservationUpdateMany: vi.fn<(input: unknown) => Promise<{ readonly count: number }>>(),
  transaction: vi.fn<PrismaTransaction>(),
  userFindUnique: vi.fn<(input: unknown) => Promise<UserRow | null>>(),
  userSanctionCreate: vi.fn<Write>(),
  userSanctionUpdateMany: vi.fn<Write>(),
  userUpdate: vi.fn<(input: unknown) => Promise<UserRow>>(),
  validateRequestCsrf: vi.fn<(request: Request, sessionId: string) => Promise<{ readonly kind: "ok" }>>()
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: routeMocks.transaction,
    reservation: { findUnique: routeMocks.reservationFindUnique }
  }
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

import { POST } from "./route";

const admin: SessionUser = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "admin-1",
  name: "관리자",
  restrictionReason: null,
  restrictedUntil: null,
  role: "ADMIN",
  studentNumber: "90000"
};

const reservation = {
  id: "reservation-1",
  status: "CONFIRMED",
  userId: "student-1"
} satisfies ReservationRow;

const student = {
  bookingStatus: "ACTIVE",
  id: reservation.userId,
  restrictionReason: null,
  restrictedUntil: null,
  role: "STUDENT"
} satisfies UserRow;

describe("admin reservation no-show route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    routeMocks.rawCalls.length = 0;
    routeMocks.requireMutatingRequestSafety.mockReturnValue(null);
    routeMocks.requireAdminSession.mockResolvedValue({ id: "session-admin", user: admin });
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    routeMocks.enforceAdminMutationRateLimit.mockResolvedValue({
      kind: "allowed",
      remaining: 9,
      resetAt: new Date("2026-06-16T00:01:00.000Z")
    });
    routeMocks.reservationFindUnique.mockResolvedValue(reservation);
    routeMocks.reservationUpdate.mockResolvedValue({ ...reservation, status: "NO_SHOW" });
    routeMocks.reservationUpdateMany.mockResolvedValue({ count: 1 });
    routeMocks.userFindUnique.mockResolvedValue(student);
    routeMocks.userUpdate.mockResolvedValue({
      ...student,
      bookingStatus: "BANNED",
      restrictionReason: "무단 미출석"
    });
    routeMocks.adminActionCreate.mockResolvedValue({ id: "action-no-show" });
    routeMocks.userSanctionCreate.mockResolvedValue({});
    routeMocks.userSanctionUpdateMany.mockResolvedValue({});
    routeMocks.auditLogCreate.mockResolvedValue({});
    routeMocks.transaction.mockImplementation(async (operation) => operation(transactionClient()));
  });

  it("records only one no-show ban for stale concurrent reads", async () => {
    routeMocks.reservationUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const first = await POST(noShowRequest(), routeContext());
    const second = await POST(noShowRequest(), routeContext());

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(routeMocks.reservationUpdateMany).toHaveBeenCalledTimes(2);
    expect(routeMocks.reservationUpdateMany).toHaveBeenCalledWith({
      data: { status: "NO_SHOW" },
      where: { id: reservation.id, status: "CONFIRMED" }
    });
    expect(routeMocks.userUpdate).toHaveBeenCalledTimes(1);
    expect(routeMocks.adminActionCreate).toHaveBeenCalledTimes(1);
    expect(routeMocks.userSanctionCreate).toHaveBeenCalledTimes(1);
    expect(routeMocks.auditLogCreate).toHaveBeenCalledTimes(1);
    const lockValues = routeMocks.rawCalls
      .filter((call) => call.strings.join("?").includes("pg_advisory_xact_lock"))
      .map((call) => call.values);
    expect(lockValues).toEqual([[`user:${reservation.userId}`], [`user:${reservation.userId}`]]);
  });

  it("returns a retryable 503 when no-show serialization is exhausted", async () => {
    routeMocks.transaction.mockRejectedValueOnce(new TransactionRetryExhaustedError(new Error("P2034")));

    const response = await POST(noShowRequest(), routeContext());

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
    reservation: {
      findUnique: routeMocks.reservationFindUnique,
      update: routeMocks.reservationUpdate,
      updateMany: routeMocks.reservationUpdateMany
    },
    user: { findUnique: routeMocks.userFindUnique, update: routeMocks.userUpdate },
    userSanction: { create: routeMocks.userSanctionCreate, updateMany: routeMocks.userSanctionUpdateMany }
  };
}

function noShowRequest(): Request {
  return new Request("https://example.test/api/admin/reservations/reservation-1/no-show", {
    body: JSON.stringify({ reason: "무단 미출석" }),
    headers: {
      "content-type": "application/json",
      "x-csrf-token": "csrf-token",
      origin: "https://example.test"
    },
    method: "POST"
  });
}

function routeContext(): { readonly params: Promise<{ readonly id: string }> } {
  return { params: Promise.resolve({ id: reservation.id }) };
}
