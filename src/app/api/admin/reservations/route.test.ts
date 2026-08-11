import { beforeEach, describe, expect, it, vi } from "vitest";

import { TransactionRetryExhaustedError } from "@/lib/db-context";
import type { RateLimitResult } from "@/lib/rate-limit";
import type { CurrentSession, SessionUser } from "@/lib/session";
import type { StudyPeriod } from "@/lib/study-periods";

type UserRow = {
  readonly bookingStatus: string;
  readonly id: string;
  readonly restrictedUntil: Date | null;
  readonly role: string;
  readonly studentNumber: string;
};

type PeriodSettingRow = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly date: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: StudyPeriod;
};

type ReservationRow = {
  readonly date: string;
  readonly id: string;
  readonly reason: string | null;
  readonly status: string;
  readonly studyPeriod: StudyPeriod;
  readonly userId: string;
};

type AdminActionCreate = (input: unknown) => Promise<{ readonly id: string }>;
type AuditLogCreate = (input: unknown) => Promise<unknown>;
type PeriodSettingFindMany = (input: unknown) => Promise<readonly PeriodSettingRow[]>;
type ReservationCount = (input: unknown) => Promise<number>;
type ReservationCreate = (input: unknown) => Promise<ReservationRow>;
type ReservationFindMany = (input: unknown) => Promise<readonly unknown[]>;
type ReservationFindUnique = (input: unknown) => Promise<ReservationRow | null>;
type UserFindUnique = (input: unknown) => Promise<UserRow | null>;
type GetMockAdminReservations = (input: unknown) => readonly unknown[];

type TransactionClient = {
  readonly $executeRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<number>;
  readonly adminAction: { readonly create: AdminActionCreate };
  readonly auditLog: { readonly create: AuditLogCreate };
  readonly periodSetting: { readonly findMany: PeriodSettingFindMany };
  readonly reservation: {
    readonly count: ReservationCount;
    readonly create: ReservationCreate;
    readonly findMany: ReservationFindMany;
    readonly findUnique: ReservationFindUnique;
  };
  readonly user: { readonly findUnique: UserFindUnique };
};

type PrismaTransaction = <T>(operation: (transaction: TransactionClient) => Promise<T>) => Promise<T>;
type RequireAdmin = () => Promise<SessionUser>;
type RequireAdminSession = () => Promise<CurrentSession>;
type ValidateRequestCsrf = (request: Request, sessionId: string) => Promise<{ readonly kind: "ok" }>;

const routeMocks = vi.hoisted(() => ({
  adminActionCreate: vi.fn<AdminActionCreate>(),
  auditLogCreate: vi.fn<AuditLogCreate>(),
  enforceAdminMutationRateLimit: vi.fn<(request: Request, userId: string) => Promise<RateLimitResult>>(),
  getMockAdminReservations: vi.fn<GetMockAdminReservations>(),
  isNoDatabaseMockMode: vi.fn<() => boolean>(),
  periodSettingFindMany: vi.fn<PeriodSettingFindMany>(),
  rawCalls: [] as Array<{ readonly strings: readonly string[]; readonly values: readonly unknown[] }>,
  requireAdmin: vi.fn<RequireAdmin>(),
  requireAdminSession: vi.fn<RequireAdminSession>(),
  requireMutatingRequestSafety: vi.fn<(request: Request) => null>(),
  reservationCount: vi.fn<ReservationCount>(),
  reservationCreate: vi.fn<ReservationCreate>(),
  reservationFindMany: vi.fn<ReservationFindMany>(),
  reservationFindUnique: vi.fn<ReservationFindUnique>(),
  transaction: vi.fn<PrismaTransaction>(),
  userFindUnique: vi.fn<UserFindUnique>(),
  validateRequestCsrf: vi.fn<ValidateRequestCsrf>()
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: routeMocks.transaction,
    reservation: { findMany: routeMocks.reservationFindMany },
    user: { findUnique: routeMocks.userFindUnique }
  }
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode
}));

vi.mock("@/lib/mock-admin-reservation-create", () => ({
  createMockAdminReservation: vi.fn()
}));

vi.mock("@/lib/mock-reservation-data", () => ({
  getMockAdminReservations: routeMocks.getMockAdminReservations
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
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {},
  requireAdmin: routeMocks.requireAdmin,
  requireAdminSession: routeMocks.requireAdminSession
}));

import { GET, POST } from "./route";

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

const targetUser = {
  bookingStatus: "ACTIVE",
  id: "student-1",
  restrictedUntil: null,
  role: "STUDENT",
  studentNumber: "25001"
} satisfies UserRow;

const createdReservation = {
  date: "2026-06-16",
  id: "reservation-created",
  reason: "관리자 수동 추가",
  status: "CONFIRMED",
  studyPeriod: "EIGHTH",
  userId: targetUser.id
} satisfies ReservationRow;

const allowedRateLimit: RateLimitResult = {
  kind: "allowed",
  remaining: 9,
  resetAt: new Date("2026-06-16T00:01:00.000Z")
};

describe("admin reservations route", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T05:00:00.000Z"));
    vi.resetAllMocks();
    routeMocks.rawCalls.length = 0;
    routeMocks.requireMutatingRequestSafety.mockReturnValue(null);
    routeMocks.requireAdmin.mockResolvedValue(adminUser);
    routeMocks.requireAdminSession.mockResolvedValue({ id: "session-admin", user: adminUser });
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    routeMocks.enforceAdminMutationRateLimit.mockResolvedValue(allowedRateLimit);
    routeMocks.getMockAdminReservations.mockReturnValue([]);
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.userFindUnique.mockResolvedValue(targetUser);
    routeMocks.periodSettingFindMany.mockResolvedValue([
      periodRow({ date: "2026-06-16", studyPeriod: "EIGHTH" })
    ]);
    routeMocks.reservationFindUnique.mockResolvedValue(null);
    routeMocks.reservationCount.mockResolvedValue(0);
    routeMocks.reservationCreate.mockResolvedValue(createdReservation);
    routeMocks.adminActionCreate.mockResolvedValue({ id: "action-create" });
    routeMocks.auditLogCreate.mockResolvedValue({});
    routeMocks.transaction.mockImplementation(async (operation) => operation(transactionClient()));
  });

  it("selects and returns only fields used by the admin reservation list", async () => {
    routeMocks.reservationFindMany.mockResolvedValue([
      {
        createdAt: new Date("2026-06-16T05:00:00.000Z"),
        date: "2026-06-16",
        id: "reservation-list-1",
        reason: "자습",
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        updatedAt: new Date("2026-06-16T05:01:00.000Z"),
        user: {
          bookingStatus: "ACTIVE",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          id: "student-list-1",
          name: "학생",
          riroId: "private-riro-id",
          role: "STUDENT",
          shadowBanProfile: "HIGH",
          studentNumber: "31001"
        },
        userId: "student-list-1"
      }
    ]);

    const response = await GET(new Request("https://example.test/api/admin/reservations?date=2026-06-16"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(routeMocks.reservationFindMany).toHaveBeenCalledWith({
      select: {
        createdAt: true,
        date: true,
        id: true,
        reason: true,
        status: true,
        studyPeriod: true,
        user: {
          select: {
            bookingStatus: true,
            id: true,
            name: true,
            role: true,
            studentNumber: true
          }
        }
      },
      where: { date: "2026-06-16" }
    });
    await expect(response.json()).resolves.toEqual({
      reservations: [
        {
          createdAt: "2026-06-16T05:00:00.000Z",
          date: "2026-06-16",
          id: "reservation-list-1",
          reason: "자습",
          status: "CONFIRMED",
          studyPeriod: "EIGHTH",
          user: {
            bookingStatus: "ACTIVE",
            id: "student-list-1",
            name: "학생",
            role: "STUDENT",
            studentNumber: "31001"
          }
        }
      ]
    });
  });

  it("returns one confirmed deep-link target outside a 100-plus general fixture Given unrelated filters When reservationId is valid Then Prisma uses its exact id/date/status lookup", async () => {
    const generalFixture = createGeneralReservationFixture();
    const target = reservationListRow({
      id: "deep-link-target-101",
      status: "CONFIRMED",
      studyPeriod: "EIGHTH",
      userId: "target-student"
    });
    routeMocks.reservationFindMany.mockImplementation(async (input) =>
      isConfirmedReservationLookup(input, target.id) ? [target] : generalFixture
    );

    const response = await GET(
      createReadRequest({
        query: "cannot-find-target",
        reservationId: target.id,
        status: "NO_SHOW",
        studyPeriod: "FIRST",
        userId: "other-student"
      })
    );

    expect(generalFixture).toHaveLength(101);
    expect(response.status).toBe(200);
    expect(routeMocks.reservationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 1,
        where: { date: "2026-06-16", id: target.id, status: "CONFIRMED" }
      })
    );
    await expect(response.json()).resolves.toEqual({ reservations: [reservationDto(target)] });
  });

  it("returns the same one confirmed deep-link target in mock mode Given unrelated filters When reservationId is valid Then mock filtering bypasses the general fixture", async () => {
    const generalFixture = createGeneralReservationFixture();
    const target = reservationListRow({
      id: "mock-deep-link-target-101",
      status: "CONFIRMED",
      studyPeriod: "EIGHTH",
      userId: "target-student"
    });
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);
    routeMocks.getMockAdminReservations.mockImplementation((input) =>
      isMockConfirmedReservationLookup(input, target.id) ? [target] : generalFixture
    );

    const response = await GET(
      createReadRequest({
        query: "cannot-find-target",
        reservationId: target.id,
        status: "NO_SHOW",
        studyPeriod: "FIRST",
        userId: "other-student"
      })
    );

    expect(generalFixture).toHaveLength(101);
    expect(response.status).toBe(200);
    expect(routeMocks.getMockAdminReservations).toHaveBeenCalledWith(
      expect.objectContaining({ date: "2026-06-16", reservationId: target.id })
    );
    await expect(response.json()).resolves.toEqual({ reservations: [reservationDto(target)] });
  });

  it("returns no target Given reservationId names a cancelled reservation When the exact confirmed lookup runs Then cancellation cannot be opened", async () => {
    const generalFixture = createGeneralReservationFixture();
    const cancelled = reservationListRow({
      id: "cancelled-deep-link-target",
      status: "CANCELLED",
      studyPeriod: "EIGHTH",
      userId: "cancelled-student"
    });
    routeMocks.reservationFindMany.mockImplementation(async (input) =>
      isConfirmedReservationLookup(input, cancelled.id) ? [] : [...generalFixture, cancelled]
    );

    const response = await GET(
      createReadRequest({
        query: "",
        reservationId: cancelled.id,
        status: "ALL",
        studyPeriod: "ALL",
        userId: null
      })
    );

    expect(response.status).toBe(200);
    expect(routeMocks.reservationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 1,
        where: { date: "2026-06-16", id: cancelled.id, status: "CONFIRMED" }
      })
    );
    await expect(response.json()).resolves.toEqual({ reservations: [] });
  });

  it("returns no target Given reservationId does not exist When the exact confirmed lookup runs Then the general fixture is not substituted", async () => {
    const generalFixture = createGeneralReservationFixture();
    const missingReservationId = "missing-deep-link-target";
    routeMocks.reservationFindMany.mockImplementation(async (input) =>
      isConfirmedReservationLookup(input, missingReservationId) ? [] : generalFixture
    );

    const response = await GET(
      createReadRequest({
        query: "",
        reservationId: missingReservationId,
        status: "ALL",
        studyPeriod: "ALL",
        userId: null
      })
    );

    expect(response.status).toBe(200);
    expect(routeMocks.reservationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 1,
        where: { date: "2026-06-16", id: missingReservationId, status: "CONFIRMED" }
      })
    );
    await expect(response.json()).resolves.toEqual({ reservations: [] });
  });

  it("returns no target Given reservationId is malformed When the list route reads the request Then the invalid id is never used as an exact lookup", async () => {
    const malformedReservationId = "invalid/reservation-id";
    routeMocks.reservationFindMany.mockResolvedValue([]);

    const response = await GET(
      createReadRequest({
        query: "",
        reservationId: malformedReservationId,
        status: "CONFIRMED",
        studyPeriod: "ALL",
        userId: null
      })
    );

    expect(response.status).toBe(200);
    expect(routeMocks.reservationFindMany).not.toHaveBeenCalled();
    expect(routeMocks.reservationFindMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: malformedReservationId }) })
    );
    await expect(response.json()).resolves.toEqual({ reservations: [] });
  });

  it("creates a confirmed reservation for the requested student and records admin audit", async () => {
    const response = await POST(createRequest({ studentNumber: targetUser.studentNumber }));

    expect(response.status).toBe(201);
    expect(routeMocks.userFindUnique).toHaveBeenNthCalledWith(1, {
      select: { id: true, role: true },
      where: { studentNumber: targetUser.studentNumber }
    });
    expect(routeMocks.userFindUnique).toHaveBeenNthCalledWith(2, { where: { id: targetUser.id } });
    expect(routeMocks.reservationCreate).toHaveBeenCalledWith({
      data: {
        date: "2026-06-16",
        reason: "관리자 수동 추가",
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        userId: targetUser.id
      }
    });
    expect(routeMocks.adminActionCreate).toHaveBeenCalledWith({
      data: {
        action: "ADMIN_RESERVATION_CREATE",
        actorId: adminUser.id,
        after: JSON.stringify({
          date: createdReservation.date,
          reservationStatus: createdReservation.status,
          studyPeriod: createdReservation.studyPeriod
        }),
        before: null,
        ipHash: expect.any(String),
        reason: "관리자 수동 추가",
        reservationId: createdReservation.id,
        targetUserId: targetUser.id
      }
    });
    expect(routeMocks.auditLogCreate).toHaveBeenCalledWith({
      data: {
        action: "ADMIN_RESERVATION_CREATE",
        actorId: adminUser.id,
        detail: JSON.stringify({
          actionId: "action-create",
          date: createdReservation.date,
          reason: "관리자 수동 추가",
          reservationId: createdReservation.id,
          studyPeriod: createdReservation.studyPeriod
        }),
        userId: targetUser.id
      }
    });
    const lockValues = routeMocks.rawCalls
      .filter((call) => call.strings.join("?").includes("pg_advisory_xact_lock"))
      .map((call) => call.values);
    expect(lockValues).toEqual([
      ["period:2026-06-16:EIGHTH"],
      [`user:${targetUser.id}`]
    ]);
  });

  it("returns a retryable 503 when the admin reservation transaction is exhausted", async () => {
    routeMocks.transaction.mockRejectedValueOnce(new TransactionRetryExhaustedError(new Error("P2034")));

    const response = await POST(createRequest({ studentNumber: targetUser.studentNumber }));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "transaction_retry_exhausted" }
    });
  });

  it("rejects adding an admin account as a student reservation", async () => {
    routeMocks.userFindUnique.mockResolvedValueOnce({ ...targetUser, role: "ADMIN" });

    const response = await POST(createRequest({ studentNumber: targetUser.studentNumber }));

    expect(response.status).toBe(403);
    expect(routeMocks.reservationCreate).not.toHaveBeenCalled();
    expect(routeMocks.adminActionCreate).not.toHaveBeenCalled();
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
      count: routeMocks.reservationCount,
      create: routeMocks.reservationCreate,
      findMany: routeMocks.reservationFindMany,
      findUnique: routeMocks.reservationFindUnique
    },
    user: { findUnique: routeMocks.userFindUnique }
  };
}

function createRequest(input: { readonly studentNumber: string }): Request {
  return new Request("https://example.test/api/admin/reservations", {
    body: JSON.stringify({
      date: "2026-06-16",
      reason: "관리자 수동 추가",
      studentNumber: input.studentNumber,
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

function periodRow(input: { readonly date: string; readonly studyPeriod: StudyPeriod }): PeriodSettingRow {
  return {
    capacity: 10,
    closeTime: "23:59",
    date: input.date,
    enabled: true,
    openTime: "00:00",
    studyPeriod: input.studyPeriod
  };
}

type ReservationListRow = ReservationRow & {
  readonly createdAt: Date;
  readonly user: {
    readonly bookingStatus: string;
    readonly id: string;
    readonly name: string;
    readonly role: string;
    readonly studentNumber: string;
  };
};

type ReadRequestInput = {
  readonly query: string;
  readonly reservationId: string;
  readonly status: string;
  readonly studyPeriod: string;
  readonly userId: string | null;
};

function createGeneralReservationFixture(): readonly ReservationListRow[] {
  return Array.from({ length: 101 }, (_unused, index) =>
    reservationListRow({
      id: `general-reservation-${index + 1}`,
      status: "NO_SHOW",
      studyPeriod: "FIRST",
      userId: `general-student-${index + 1}`
    })
  );
}

function reservationListRow(input: {
  readonly id: string;
  readonly status: string;
  readonly studyPeriod: StudyPeriod;
  readonly userId: string;
}): ReservationListRow {
  return {
    createdAt: new Date("2026-06-16T05:00:00.000Z"),
    date: "2026-06-16",
    id: input.id,
    reason: null,
    status: input.status,
    studyPeriod: input.studyPeriod,
    user: {
      bookingStatus: "ACTIVE",
      id: input.userId,
      name: `학생 ${input.userId}`,
      role: "STUDENT",
      studentNumber: `3${input.userId.slice(-4).padStart(4, "0")}`
    },
    userId: input.userId
  };
}

function createReadRequest(input: ReadRequestInput): Request {
  const params = new URLSearchParams({
    date: "2026-06-16",
    query: input.query,
    reservationId: input.reservationId,
    status: input.status,
    studyPeriod: input.studyPeriod
  });
  if (input.userId !== null) {
    params.set("userId", input.userId);
  }
  return new Request(`https://example.test/api/admin/reservations?${params.toString()}`);
}

function isConfirmedReservationLookup(input: unknown, reservationId: string): boolean {
  if (typeof input !== "object" || input === null || !("where" in input)) {
    return false;
  }
  const where = input.where;
  if (
    typeof where !== "object" ||
    where === null ||
    !("date" in where) ||
    !("id" in where) ||
    !("status" in where)
  ) {
    return false;
  }
  return where.date === "2026-06-16" && where.id === reservationId && where.status === "CONFIRMED";
}

function isMockConfirmedReservationLookup(input: unknown, reservationId: string): boolean {
  if (typeof input !== "object" || input === null || !("date" in input) || !("reservationId" in input)) {
    return false;
  }
  return input.date === "2026-06-16" && input.reservationId === reservationId;
}

function reservationDto(reservation: ReservationListRow): object {
  return {
    createdAt: reservation.createdAt.toISOString(),
    date: reservation.date,
    id: reservation.id,
    reason: reservation.reason,
    status: reservation.status,
    studyPeriod: reservation.studyPeriod,
    user: reservation.user
  };
}
