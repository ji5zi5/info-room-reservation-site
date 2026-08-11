import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TransactionRetryExhaustedError } from "@/lib/db-context";
import type { DatabaseActor } from "@/lib/db-context";
import type { RateLimitResult } from "@/lib/rate-limit";
import type { CurrentSession, SessionUser } from "@/lib/session";

type ReservationRow = {
  readonly id: string;
  readonly status: string;
  readonly userId: string;
};
type ReservationFindUnique = (input: unknown) => Promise<ReservationRow | null>;
type ReservationUpdate = (input: unknown) => Promise<ReservationRow>;
type ReservationUpdateMany = (input: unknown) => Promise<{ readonly count: number }>;
type AdminActionCreate = (input: unknown) => Promise<{ readonly id: string }>;
type AuditLogCreate = (input: unknown) => Promise<unknown>;
type TransactionClient = {
  readonly $executeRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<number>;
  readonly adminAction: { readonly create: AdminActionCreate };
  readonly auditLog: { readonly create: AuditLogCreate };
  readonly reservation: {
    readonly findUnique: ReservationFindUnique;
    readonly update: ReservationUpdate;
    readonly updateMany: ReservationUpdateMany;
  };
};
type PrismaTransaction = <T>(operation: (transaction: TransactionClient) => Promise<T>) => Promise<T>;
type DatabaseContextClient = {
  readonly reservation: { readonly findUnique: ReservationFindUnique };
};
type WithDatabaseContext = <T>(input: {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: DatabaseContextClient) => Promise<T>;
}) => Promise<T>;
type RequireAdminSession = () => Promise<CurrentSession>;
type ValidateRequestCsrf = (request: Request, sessionId: string) => Promise<{ readonly kind: "ok" }>;
type MockCancellationResult =
  | { readonly kind: "cancelled"; readonly reservation: ReservationRow; readonly user: SessionUser }
  | { readonly kind: "not_cancellable"; readonly reservation: ReservationRow; readonly user: SessionUser }
  | { readonly kind: "not_found" };
type CancelMockReservation = (input: unknown) => MockCancellationResult;

const routeMocks = vi.hoisted(() => ({
  adminActionCreate: vi.fn<AdminActionCreate>(),
  auditLogCreate: vi.fn<AuditLogCreate>(),
  cancelMockReservation: vi.fn<CancelMockReservation>(),
  databaseActorFromSessionUser: vi.fn<(user: SessionUser) => DatabaseActor>(),
  enforceAdminMutationRateLimit: vi.fn<(request: Request, userId: string) => Promise<RateLimitResult>>(),
  isNoDatabaseMockMode: vi.fn<() => boolean>(),
  requireAdminSession: vi.fn<RequireAdminSession>(),
  requireMutatingRequestSafety: vi.fn<(request: Request) => null>(),
  rawCalls: [] as Array<{ readonly strings: readonly string[]; readonly values: readonly unknown[] }>,
  rawReservationFindUnique: vi.fn<ReservationFindUnique>(),
  reservationFindUnique: vi.fn<ReservationFindUnique>(),
  reservationUpdate: vi.fn<ReservationUpdate>(),
  reservationUpdateMany: vi.fn<ReservationUpdateMany>(),
  scopedReservationFindUnique: vi.fn<ReservationFindUnique>(),
  transaction: vi.fn<PrismaTransaction>(),
  validateRequestCsrf: vi.fn<ValidateRequestCsrf>(),
  withDatabaseContext: vi.fn<WithDatabaseContext>()
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: routeMocks.transaction,
    reservation: { findUnique: routeMocks.rawReservationFindUnique }
  }
}));

vi.mock("@/lib/db-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db-context")>();
  return {
    ...actual,
    databaseActorFromSessionUser: routeMocks.databaseActorFromSessionUser,
    withDatabaseContext: routeMocks.withDatabaseContext
  };
});

vi.mock("@/lib/request-csrf", () => ({
  messageForCsrfError: (reason: string) => `csrf:${reason}`,
  validateRequestCsrf: routeMocks.validateRequestCsrf
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode
}));

vi.mock("@/lib/mock-reservation-data", () => ({
  cancelMockReservation: routeMocks.cancelMockReservation
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

const adminUser: SessionUser = {
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

const allowedRateLimit: RateLimitResult = {
  kind: "allowed",
  remaining: 9,
  resetAt: new Date("2026-06-16T00:01:00.000Z")
};

describe("admin reservation cancel route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    routeMocks.rawCalls.length = 0;
    routeMocks.requireMutatingRequestSafety.mockReturnValue(null);
    routeMocks.requireAdminSession.mockResolvedValue({ id: "session-admin", user: adminUser });
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    routeMocks.enforceAdminMutationRateLimit.mockResolvedValue(allowedRateLimit);
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.cancelMockReservation.mockReturnValue({ kind: "not_found" });
    routeMocks.databaseActorFromSessionUser.mockImplementation((user) => ({ id: user.id, role: "ADMIN" }));
    routeMocks.rawReservationFindUnique.mockResolvedValue(reservation);
    routeMocks.reservationFindUnique.mockResolvedValue(reservation);
    routeMocks.scopedReservationFindUnique.mockResolvedValue(reservation);
    routeMocks.reservationUpdate.mockResolvedValue({ ...reservation, status: "CANCELLED" });
    routeMocks.reservationUpdateMany.mockResolvedValue({ count: 1 });
    routeMocks.adminActionCreate.mockResolvedValue({ id: "action-cancel" });
    routeMocks.auditLogCreate.mockResolvedValue({});
    routeMocks.withDatabaseContext.mockImplementation(async (input) => input.operation(databaseContextClient()));
    routeMocks.transaction.mockImplementation(async (operation) => operation(transactionClient()));
  });

  it("reads the target reservation through the authenticated ADMIN context before deriving the user lock key", async () => {
    // Given
    const adminActor = { id: adminUser.id, role: "ADMIN" } satisfies DatabaseActor;

    // When
    const response = await POST(cancelRequest({ reason: "운영 취소" }), cancelContext());

    // Then
    expect(response.status).toBe(200);
    expect(routeMocks.databaseActorFromSessionUser).toHaveBeenCalledWith(adminUser);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledWith({
      actor: adminActor,
      client: expect.anything(),
      operation: expect.any(Function)
    });
    expect(routeMocks.rawReservationFindUnique).not.toHaveBeenCalled();
    expect(routeMocks.scopedReservationFindUnique).toHaveBeenCalledWith({
      select: { userId: true },
      where: { id: reservation.id }
    });
    expect(routeMocks.withDatabaseContext.mock.invocationCallOrder[0]).toBeLessThan(
      routeMocks.transaction.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it("returns 404 from the scoped pre-lock read without entering the mutation when the reservation is absent", async () => {
    // Given
    routeMocks.scopedReservationFindUnique.mockResolvedValueOnce(null);

    // When
    const response = await POST(cancelRequest({ reason: "운영 취소" }), cancelContext());

    // Then
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not_found" } });
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledOnce();
    expect(routeMocks.rawReservationFindUnique).not.toHaveBeenCalled();
    expect(routeMocks.transaction).not.toHaveBeenCalled();
  });

  it("stores the admin cancellation reason in the action and audit log", async () => {
    const response = await POST(cancelRequest({ reason: "행사 준비로 정보실 사용 불가" }), cancelContext());

    expect(response.status).toBe(200);
    expect(routeMocks.adminActionCreate).toHaveBeenCalledWith({
      data: {
        action: "ADMIN_RESERVATION_CANCEL",
        actorId: adminUser.id,
        after: JSON.stringify({ reservationStatus: "CANCELLED" }),
        before: JSON.stringify({ reservationStatus: "CONFIRMED" }),
        ipHash: expect.any(String),
        reason: "행사 준비로 정보실 사용 불가",
        reservationId: reservation.id,
        targetUserId: reservation.userId
      }
    });
    expect(routeMocks.auditLogCreate).toHaveBeenCalledWith({
      data: {
        action: "ADMIN_RESERVATION_CANCEL",
        actorId: adminUser.id,
        detail: JSON.stringify({
          actionId: "action-cancel",
          reason: "행사 준비로 정보실 사용 불가",
          reservationId: reservation.id
        }),
        userId: reservation.userId
      }
    });
    expect(routeMocks.reservationUpdateMany).toHaveBeenCalledWith({
      data: { status: "CANCELLED" },
      where: { id: reservation.id, status: "CONFIRMED" }
    });
    expect(routeMocks.reservationUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      routeMocks.adminActionCreate.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    const lockValues = routeMocks.rawCalls
      .filter((call) => call.strings.join("?").includes("pg_advisory_xact_lock"))
      .map((call) => call.values);
    expect(lockValues).toEqual([[`user:${reservation.userId}`]]);
  });

  it("records only one admin cancellation when two requests race on the status guard", async () => {
    // Given
    const firstTransactionEntered = deferred();
    const releaseFirstTransaction = deferred();
    routeMocks.reservationUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    routeMocks.transaction
      .mockImplementationOnce(async (operation) => {
        const result = await operation(transactionClient());
        firstTransactionEntered.resolve();
        await releaseFirstTransaction.promise;
        return result;
      })
      .mockImplementationOnce(async (operation) => {
        await releaseFirstTransaction.promise;
        return operation(transactionClient());
      });

    // When
    const firstPromise = POST(cancelRequest({ reason: "운영 취소" }), cancelContext());
    await firstTransactionEntered.promise;
    const secondPromise = POST(cancelRequest({ reason: "운영 취소" }), cancelContext());
    releaseFirstTransaction.resolve();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    // Then
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(routeMocks.reservationUpdateMany).toHaveBeenCalledTimes(2);
    expect(routeMocks.adminActionCreate).toHaveBeenCalledTimes(1);
    expect(routeMocks.auditLogCreate).toHaveBeenCalledTimes(1);
  });

  it("maps only an exhausted three-attempt P2034 cancellation to the bounded conflict response", async () => {
    // Given
    routeMocks.transaction.mockImplementation(async (operation) => {
      await operation(transactionClient());
      throw serializableConflict();
    });

    // When
    const response = await POST(cancelRequest({ reason: "운영 취소" }), cancelContext());

    // Then
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "bad_request" } });
    expect(routeMocks.transaction).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["an exhausted non-serializable cause", new TransactionRetryExhaustedError(new Error("connection lost"))],
    ["an unknown transaction failure", new Error("unknown failure")]
  ])("returns 500 for %s", async (_label, failure) => {
    // Given
    routeMocks.transaction.mockRejectedValueOnce(failure);

    // When
    const response = await POST(cancelRequest({ reason: "운영 취소" }), cancelContext());

    // Then
    expect(response.status).toBe(500);
  });

  it("rejects an admin cancellation without a reason before mutating reservations", async () => {
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);

    const response = await POST(cancelRequest({ reason: "   " }), cancelContext());

    expect(response.status).toBe(400);
    expect(routeMocks.transaction).not.toHaveBeenCalled();
    expect(routeMocks.cancelMockReservation).not.toHaveBeenCalled();
  });

  it("returns 409 when the same mock reservation is cancelled a second time", async () => {
    // Given
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);
    routeMocks.cancelMockReservation
      .mockReturnValueOnce({ kind: "cancelled", reservation: { ...reservation, status: "CANCELLED" }, user: adminUser })
      .mockReturnValueOnce({ kind: "not_cancellable", reservation, user: adminUser });

    // When
    const first = await POST(cancelRequest({ reason: "운영 취소" }), cancelContext());
    const second = await POST(cancelRequest({ reason: "운영 취소" }), cancelContext());

    // Then
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: { code: "bad_request" } });
    expect(routeMocks.rawReservationFindUnique).not.toHaveBeenCalled();
  });

  it.each([
    [
      "cancels a confirmed mock reservation",
      { kind: "cancelled", reservation: { ...reservation, status: "CANCELLED" }, user: adminUser },
      200,
      undefined
    ],
    ["returns not found for an unknown mock reservation", { kind: "not_found" }, 404, "not_found"]
  ] as const)("%s Given no-database mock mode When an admin submits a valid cancellation Then it keeps the real route contract", async (_label, result, expectedStatus, expectedCode) => {
    // Given
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);
    routeMocks.cancelMockReservation.mockReturnValue(result);

    // When
    const response = await POST(cancelRequest({ reason: "운영 취소" }), cancelContext());

    // Then
    expect(response.status).toBe(expectedStatus);
    expect(routeMocks.cancelMockReservation).toHaveBeenCalledWith({
      id: reservation.id,
      now: expect.any(Date),
      requireConfirmed: true,
      user: adminUser
    });
    expect(routeMocks.rawReservationFindUnique).not.toHaveBeenCalled();
    if (expectedCode) {
      await expect(response.json()).resolves.toMatchObject({ error: { code: expectedCode } });
      return;
    }
    await expect(response.json()).resolves.toMatchObject({ reservation: { id: reservation.id, status: "CANCELLED" } });
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
    }
  };
}

function databaseContextClient(): DatabaseContextClient {
  return { reservation: { findUnique: routeMocks.scopedReservationFindUnique } };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      resolvePromise?.();
    }
  };
}

function serializableConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("serialization conflict", {
    clientVersion: "test",
    code: "P2034"
  });
}

function cancelRequest(body: unknown): Request {
  return new Request("https://example.test/api/admin/reservations/reservation-1/cancel", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-csrf-token": "csrf-token",
      origin: "https://example.test"
    },
    method: "POST"
  });
}

function cancelContext(): { readonly params: Promise<{ readonly id: string }> } {
  return { params: Promise.resolve({ id: reservation.id }) };
}
