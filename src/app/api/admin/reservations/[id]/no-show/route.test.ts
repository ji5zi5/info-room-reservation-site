import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TransactionRetryExhaustedError } from "@/lib/db-context";
import type { DatabaseActor } from "@/lib/db-context";
import { isPeriodWindowClosed } from "@/lib/period-window";
import type { RateLimitResult } from "@/lib/rate-limit";
import type { CurrentSession, SessionUser } from "@/lib/session";

type ReservationRow = {
  readonly date: string;
  readonly id: string;
  readonly status: string;
  readonly studyPeriod: string;
  readonly userId: string;
};

type PeriodSettingRow = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly date: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: string;
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
  readonly periodSetting: { readonly findMany: (input: unknown) => Promise<readonly PeriodSettingRow[]> };
  readonly reservation: {
    readonly findMany: (input: unknown) => Promise<readonly ReservationRow[]>;
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
type DatabaseContextClient = {
  readonly reservation: { readonly findUnique: (input: unknown) => Promise<ReservationRow | null> };
};
type WithDatabaseContext = <T>(input: {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: DatabaseContextClient) => Promise<T>;
}) => Promise<T>;

const routeMocks = vi.hoisted(() => ({
  adminActionCreate: vi.fn<(input: unknown) => Promise<{ readonly id: string }>>(),
  auditLogCreate: vi.fn<Write>(),
  databaseActorFromSessionUser: vi.fn<(user: SessionUser) => DatabaseActor>(),
  enforceAdminMutationRateLimit: vi.fn<(request: Request, userId: string) => Promise<RateLimitResult>>(),
  periodSettingFindMany: vi.fn<(input: unknown) => Promise<readonly PeriodSettingRow[]>>(),
  rawCalls: [] as Array<{ readonly strings: readonly string[]; readonly values: readonly unknown[] }>,
  requireAdminSession: vi.fn<() => Promise<CurrentSession>>(),
  requireMutatingRequestSafety: vi.fn<(request: Request) => null>(),
  rawReservationFindUnique: vi.fn<(input: unknown) => Promise<ReservationRow | null>>(),
  reservationFindUnique: vi.fn<(input: unknown) => Promise<ReservationRow | null>>(),
  reservationFindMany: vi.fn<(input: unknown) => Promise<readonly ReservationRow[]>>(),
  reservationUpdate: vi.fn<(input: unknown) => Promise<ReservationRow>>(),
  reservationUpdateMany: vi.fn<(input: unknown) => Promise<{ readonly count: number }>>(),
  scopedReservationFindUnique: vi.fn<(input: unknown) => Promise<ReservationRow | null>>(),
  transaction: vi.fn<PrismaTransaction>(),
  userFindUnique: vi.fn<(input: unknown) => Promise<UserRow | null>>(),
  userSanctionCreate: vi.fn<Write>(),
  userSanctionUpdateMany: vi.fn<Write>(),
  userUpdate: vi.fn<(input: unknown) => Promise<UserRow>>(),
  validateRequestCsrf: vi.fn<(request: Request, sessionId: string) => Promise<{ readonly kind: "ok" }>>(),
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
  date: "2026-06-16",
  id: "reservation-1",
  status: "CONFIRMED",
  studyPeriod: "EIGHTH",
  userId: "student-1"
} satisfies ReservationRow;

const cancellableReservations = [
  { ...reservation, id: "open-today", studyPeriod: "FIRST" },
  { ...reservation, date: "2026-06-17", id: "future" },
  { ...reservation, id: "closed-today" }
] satisfies readonly ReservationRow[];

const student = {
  bookingStatus: "ACTIVE",
  id: reservation.userId,
  restrictionReason: null,
  restrictedUntil: null,
  role: "STUDENT"
} satisfies UserRow;

describe("admin reservation no-show route", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T07:20:00.000Z"));
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
    routeMocks.databaseActorFromSessionUser.mockImplementation((user) => ({ id: user.id, role: "ADMIN" }));
    routeMocks.rawReservationFindUnique.mockResolvedValue(reservation);
    routeMocks.scopedReservationFindUnique.mockResolvedValue(reservation);
    routeMocks.withDatabaseContext.mockImplementation(async (input) => input.operation(databaseContextClient()));
    routeMocks.reservationFindUnique.mockResolvedValue(reservation);
    routeMocks.reservationUpdate.mockResolvedValue({ ...reservation, status: "NO_SHOW" });
    routeMocks.reservationFindMany.mockResolvedValue(cancellableReservations);
    routeMocks.periodSettingFindMany.mockResolvedValue([
      periodSetting("__global__", "FIRST", "16:20"),
      periodSetting("2026-06-16", "EIGHTH", "16:19")
    ]);
    routeMocks.reservationUpdateMany.mockImplementation(async (input) => {
      const status = mutationStatus(input);
      return { count: status === "NO_SHOW" ? 1 : 2 };
    });
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the target reservation through the authenticated ADMIN context before deriving the user lock key", async () => {
    // Given
    const adminActor = { id: admin.id, role: "ADMIN" } satisfies DatabaseActor;

    // When
    const response = await POST(noShowRequest(), routeContext());

    // Then
    expect(response.status).toBe(200);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledWith(
      expect.objectContaining({ actor: adminActor, client: expect.anything(), operation: expect.any(Function) })
    );
    expect(routeMocks.rawReservationFindUnique).not.toHaveBeenCalled();
    expect(routeMocks.scopedReservationFindUnique).toHaveBeenCalledWith({
      select: { userId: true },
      where: { id: reservation.id }
    });
  });

  it("returns 404 from the scoped pre-lock read without entering the mutation when the reservation is absent", async () => {
    // Given
    routeMocks.scopedReservationFindUnique.mockResolvedValueOnce(null);

    // When
    const response = await POST(noShowRequest(), routeContext());

    // Then
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not_found" } });
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledOnce();
    expect(routeMocks.rawReservationFindUnique).not.toHaveBeenCalled();
    expect(routeMocks.transaction).not.toHaveBeenCalled();
  });

  it("maps administrator targets to the preserved 403 code without mutation", async () => {
    // Given
    routeMocks.userFindUnique.mockResolvedValue({ ...student, role: "ADMIN" });

    // When
    const response = await POST(noShowRequest(), routeContext());

    // Then
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "admin_target" } });
    expect(routeMocks.reservationUpdateMany).not.toHaveBeenCalled();
  });

  it("maps replayed terminal reservations to invalid_status without side effects", async () => {
    // Given
    routeMocks.reservationFindUnique.mockResolvedValue({ ...reservation, status: "NO_SHOW" });

    // When
    const response = await POST(noShowRequest(), routeContext());

    // Then
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_status" } });
    expect(routeMocks.userUpdate).not.toHaveBeenCalled();
    expect(routeMocks.adminActionCreate).not.toHaveBeenCalled();
  });

  it("marks the selected row first, cancels only other still-open-today and future rows, and reports the count", async () => {
    // Given
    const now = new Date("2026-06-16T07:20:00.000Z");
    expect(
      isPeriodWindowClosed({ closeTime: "16:19", date: "2026-06-16", openTime: "13:00" }, now)
    ).toBe(true);
    expect(
      isPeriodWindowClosed({ closeTime: "16:20", date: "2026-06-16", openTime: "13:00" }, now)
    ).toBe(false);

    // When
    const response = await POST(noShowRequest(), routeContext());

    // Then
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cancelledFutureReservationCount: 2,
      reservation: { id: reservation.id, status: "NO_SHOW" },
      user: { bookingStatus: "BANNED", id: student.id }
    });
    expect(routeMocks.reservationUpdateMany.mock.calls[0]?.[0]).toEqual({
      data: { status: "NO_SHOW" },
      where: { id: reservation.id, status: "CONFIRMED" }
    });
    expect(routeMocks.reservationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          date: { gte: "2026-06-16" },
          id: { not: reservation.id },
          status: "CONFIRMED",
          userId: student.id
        })
      })
    );
    expect(routeMocks.periodSettingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { date: { in: ["2026-06-16", "__global__"] } } })
    );
    expect(cancelledIds()).toEqual(["open-today", "future"]);
    expect(cancelledIds()).not.toEqual(
      expect.arrayContaining([reservation.id, "closed-today", "past", "cancelled", "no-show"])
    );

    const actionInput = routeMocks.adminActionCreate.mock.calls[0]?.[0] as { readonly data: { readonly after: string } };
    expect(JSON.parse(actionInput.data.after)).toMatchObject({ cancelledFutureReservationCount: 2 });
    const auditInput = routeMocks.auditLogCreate.mock.calls[0]?.[0] as { readonly data: { readonly detail: string } };
    expect(JSON.parse(auditInput.data.detail)).toMatchObject({ cancelledFutureReservationCount: 2 });
    expect(routeMocks.reservationUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      routeMocks.adminActionCreate.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it("fails closed without effective settings and does not mutate", async () => {
    // Given
    vi.setSystemTime(new Date("2026-06-16T07:19:00.000Z"));
    routeMocks.periodSettingFindMany.mockResolvedValue([]);
    routeMocks.reservationFindMany.mockResolvedValue([{ ...reservation, id: "default-open-today" }]);
    expect(
      isPeriodWindowClosed(
        { closeTime: "16:20", date: "2026-06-16", openTime: "13:00" },
        new Date("2026-06-16T07:19:00.000Z")
      )
    ).toBe(false);

    // When
    const response = await POST(noShowRequest(), routeContext());

    // Then
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not_closed" } });
    expect(routeMocks.reservationUpdateMany).not.toHaveBeenCalled();
    expect(routeMocks.userUpdate).not.toHaveBeenCalled();
  });

  it("records only one no-show ban when two requests race on the selected status guard", async () => {
    // Given
    let selectedTransitions = 0;
    const firstTransactionEntered = deferred();
    const releaseFirstTransaction = deferred();
    routeMocks.reservationUpdateMany.mockImplementation(async (input) => {
      if (mutationStatus(input) === "CANCELLED") {
        return { count: 0 };
      }
      selectedTransitions += 1;
      return { count: selectedTransitions === 1 ? 1 : 0 };
    });
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
    const firstPromise = POST(noShowRequest(), routeContext());
    await firstTransactionEntered.promise;
    const secondPromise = POST(noShowRequest(), routeContext());
    releaseFirstTransaction.resolve();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    // Then
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: { code: "conflict" } });
    expect(selectedTransitions).toBe(2);
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

  it("maps only an exhausted three-attempt P2034 no-show to the bounded conflict response", async () => {
    // Given
    vi.useRealTimers();
    routeMocks.transaction.mockImplementation(async (operation) => {
      await operation(transactionClient());
      throw serializableConflict();
    });

    // When
    const response = await POST(noShowRequest(), routeContext());

    // Then
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "conflict" } });
    expect(routeMocks.transaction).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["an exhausted non-serializable cause", new TransactionRetryExhaustedError(new Error("connection lost"))],
    ["an unknown transaction failure", new Error("unknown failure")]
  ])("returns 500 for %s", async (_label, failure) => {
    // Given
    routeMocks.transaction.mockRejectedValueOnce(failure);

    // When
    const response = await POST(noShowRequest(), routeContext());

    // Then
    expect(response.status).toBe(500);
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
    periodSetting: { findMany: routeMocks.periodSettingFindMany },
    reservation: {
      findMany: routeMocks.reservationFindMany,
      findUnique: routeMocks.reservationFindUnique,
      update: routeMocks.reservationUpdate,
      updateMany: routeMocks.reservationUpdateMany
    },
    user: { findUnique: routeMocks.userFindUnique, update: routeMocks.userUpdate },
    userSanction: { create: routeMocks.userSanctionCreate, updateMany: routeMocks.userSanctionUpdateMany }
  };
}

function databaseContextClient(): DatabaseContextClient {
  return { reservation: { findUnique: routeMocks.scopedReservationFindUnique } };
}

function cancelledIds(): readonly string[] {
  const cancellation = routeMocks.reservationUpdateMany.mock.calls
    .map(([input]) => input)
    .find((input) => mutationStatus(input) === "CANCELLED");
  if (!cancellation) {
    return [];
  }
  const where = (cancellation as { readonly where?: { readonly id?: { readonly in?: readonly string[] } } }).where;
  return where?.id?.in ?? [];
}

function mutationStatus(input: unknown): string | undefined {
  return (input as { readonly data?: { readonly status?: string } }).data?.status;
}

function periodSetting(date: string, studyPeriod: string, closeTime: string): PeriodSettingRow {
  return { capacity: 10, closeTime, date, enabled: true, openTime: "13:00", studyPeriod };
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
