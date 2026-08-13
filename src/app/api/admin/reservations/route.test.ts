import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

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
  mockReservations: [] as unknown[],
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

vi.mock("@/lib/mock-reservation-state", () => ({
  mockReservations: routeMocks.mockReservations
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
    vi.stubEnv("SESSION_SECRET", "todo-12-route-cursor-secret");
    vi.resetAllMocks();
    routeMocks.mockReservations.length = 0;
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

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("selects and returns only fields used by the admin reservation list", async () => {
    // Given: one filtered reservation and its current matching count.
    routeMocks.reservationCount.mockResolvedValue(1);
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

    // When: the first bounded page is requested.
    const response = await GET(new Request("https://example.test/api/admin/reservations?date=2026-06-16"));

    // Then: the database query is bounded and the response is a strict terminal page.
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(routeMocks.reservationFindMany).toHaveBeenCalledWith({
      orderBy: [{ studyPeriod: "asc" }, { createdAt: "asc" }, { id: "asc" }],
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
      take: 51,
      where: {
        createdAt: { lte: new Date("2026-06-16T05:00:00.000Z") },
        date: "2026-06-16",
        status: "CONFIRMED"
      }
    });
    await expect(response.json()).resolves.toEqual(pagePayload([
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
      ], 1));
  });

  it("returns one terminal exact target outside a 100-plus fixture regardless of list filters", async () => {
    // Given: a cancelled exact target outside an unrelated 101-row fixture.
    const generalFixture = createGeneralReservationFixture();
    const target = reservationListRow({
      id: "deep-link-target-101",
      status: "CANCELLED",
      studyPeriod: "EIGHTH",
      userId: "target-student"
    });
    routeMocks.reservationFindMany.mockImplementation(async (input) =>
      isExactReservationLookup(input, target.id) ? [target] : generalFixture
    );

    // When: the exact ID is requested with conflicting date/status/list filters.
    const response = await GET(
      createReadRequest({
        query: "cannot-find-target",
        reservationId: target.id,
        status: "NO_SHOW",
        studyPeriod: "FIRST",
        userId: "other-student"
      })
    );

    // Then: only the exact ID is queried and its terminal status is preserved.
    expect(generalFixture).toHaveLength(101);
    expect(response.status).toBe(200);
    expect(routeMocks.reservationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 1,
        where: { id: target.id }
      })
    );
    await expect(response.json()).resolves.toEqual(pagePayload([reservationDto(target)], 1));
  });

  it("returns a non-confirmed off-date reservation by exact ID in mock mode", async () => {
    // Given: a cancelled mock target exists only outside the requested date and status.
    const target = {
      ...reservationListRow({
      id: "mock-deep-link-target-101",
      status: "CANCELLED",
      studyPeriod: "EIGHTH",
      userId: "target-student"
      }),
      date: "2026-06-15"
    };
    routeMocks.mockReservations.push(target);
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);

    // When: the exact ID is requested with a different date and status filter.
    const response = await GET(
      createReadRequest({
        query: "cannot-find-target",
        reservationId: target.id,
        status: "NO_SHOW",
        studyPeriod: "FIRST",
        userId: "other-student"
      })
    );

    // Then: mock mode uses ID-only semantics just like Prisma.
    expect(response.status).toBe(200);
    expect(routeMocks.getMockAdminReservations).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(pagePayload([reservationDto(target)], 1));
  });

  it("paginates more than 50 filtered mock reservations with a signed cursor", async () => {
    // Given: 52 matching rows cross the period tuple at the cutoff, with one later row excluded.
    const fixture = [
      ...Array.from({ length: 2 }, (_unused, index) => reservationListRow({
        id: `mock-page-first-${String(index + 1).padStart(3, "0")}`,
        status: "CONFIRMED",
        studyPeriod: "FIRST",
        userId: `mock-page-first-student-${String(index + 1).padStart(3, "0")}`
      })),
      ...Array.from({ length: 50 }, (_unused, index) => reservationListRow({
        id: `mock-page-eighth-${String(index + 1).padStart(3, "0")}`,
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        userId: `mock-page-eighth-student-${String(index + 1).padStart(3, "0")}`
      })),
      reservationListRow({
        createdAt: new Date("2026-06-16T05:00:00.001Z"),
        id: "mock-page-after-cutoff",
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        userId: "mock-page-after-cutoff-student"
      })
    ].reverse();
    routeMocks.getMockAdminReservations.mockReturnValue(fixture);
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);

    const pageSchema = z.object({
      currentTotalCount: z.number(),
      items: z.array(z.object({ id: z.string() })),
      nextCursor: z.string().nullable()
    });

    // When: page one and page two use the route-issued cursor with unchanged filters.
    const firstResponse = await GET(createReadRequest({
      query: "",
      reservationId: "",
      status: "CONFIRMED",
      studyPeriod: "ALL",
      userId: null
    }));
    const firstPage = pageSchema.parse(await firstResponse.json());
    const secondResponse = await GET(createReadRequest({
      cursor: firstPage.nextCursor,
      query: "",
      reservationId: "",
      status: "CONFIRMED",
      studyPeriod: "ALL",
      userId: null
    }));
    const secondPage = pageSchema.parse(await secondResponse.json());

    // Then: pagination preserves the tuple, cutoff, total, signed filter binding, and terminal page.
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstPage.currentTotalCount).toBe(52);
    expect(firstPage.items.map((item) => item.id)).toEqual(
      Array.from({ length: 50 }, (_unused, index) => `mock-page-eighth-${String(index + 1).padStart(3, "0")}`)
    );
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(secondPage.currentTotalCount).toBe(52);
    expect(secondPage.items.map((item) => item.id)).toEqual(["mock-page-first-001", "mock-page-first-002"]);
    expect(secondPage.nextCursor).toBeNull();
    const seenIds = [...firstPage.items, ...secondPage.items].map((item) => item.id);
    expect(new Set(seenIds).size).toBe(52);
    expect(seenIds).not.toContain("mock-page-after-cutoff");
    expect(routeMocks.getMockAdminReservations).toHaveBeenCalledTimes(2);
    expect(routeMocks.getMockAdminReservations).toHaveBeenCalledWith({
      date: "2026-06-16",
      filters: { query: "", studyPeriod: "ALL", userId: null },
      status: "CONFIRMED"
    });

    const alteredFilterResponse = await GET(createReadRequest({
      cursor: firstPage.nextCursor,
      query: "changed",
      reservationId: "",
      status: "CONFIRMED",
      studyPeriod: "ALL",
      userId: null
    }));
    expect(alteredFilterResponse.status).toBe(400);
    await expect(alteredFilterResponse.json()).resolves.toMatchObject({ error: { code: "CURSOR_FILTER_MISMATCH" } });
  });

  it("returns a cancelled reservation when its exact ID is authorized", async () => {
    // Given: a cancelled reservation that would be excluded by the active list filters.
    const generalFixture = createGeneralReservationFixture();
    const cancelled = reservationListRow({
      id: "cancelled-deep-link-target",
      status: "CANCELLED",
      studyPeriod: "EIGHTH",
      userId: "cancelled-student"
    });
    routeMocks.reservationFindMany.mockImplementation(async (input) =>
      isExactReservationLookup(input, cancelled.id) ? [cancelled] : [...generalFixture, cancelled]
    );

    // When: its exact ID is requested.
    const response = await GET(
      createReadRequest({
        query: "",
        reservationId: cancelled.id,
        status: "ALL",
        studyPeriod: "ALL",
        userId: null
      })
    );

    // Then: status filters do not hide the authorized exact target.
    expect(response.status).toBe(200);
    expect(routeMocks.reservationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 1,
        where: { id: cancelled.id }
      })
    );
    await expect(response.json()).resolves.toEqual(pagePayload([reservationDto(cancelled)], 1));
  });

  it("keeps cursor order and cutoff while status drift changes the current total", async () => {
    // Given: 52 confirmed reservations and a status change after the first page is issued.
    const fixture = [
      ...Array.from({ length: 50 }, (_unused, index) => reservationListRow({
        id: `drift-eighth-${String(index + 1).padStart(3, "0")}`,
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        userId: `drift-eighth-student-${String(index + 1).padStart(3, "0")}`
      })),
      ...Array.from({ length: 2 }, (_unused, index) => reservationListRow({
        id: `drift-first-${String(index + 1).padStart(3, "0")}`,
        status: "CONFIRMED",
        studyPeriod: "FIRST",
        userId: `drift-first-student-${String(index + 1).padStart(3, "0")}`
      }))
    ];
    routeMocks.reservationCount.mockImplementation(async () =>
      fixture.filter((reservation) => reservation.status === "CONFIRMED").length
    );
    routeMocks.reservationFindMany.mockImplementation(async () => {
      const confirmed = fixture.filter((reservation) => reservation.status === "CONFIRMED");
      return routeMocks.reservationFindMany.mock.calls.length === 1
        ? confirmed.slice(0, 51)
        : confirmed.slice(50);
    });
    const pageSchema = z.object({
      cutoff: z.string(),
      currentTotalCount: z.number(),
      expiresAt: z.string(),
      items: z.array(z.object({ id: z.string() })),
      nextCursor: z.string().nullable()
    });

    // When: page two reuses page one's cursor after the final reservation leaves the status filter.
    const firstResponse = await GET(createReadRequest({
      query: "drift",
      reservationId: "",
      status: "CONFIRMED",
      studyPeriod: "ALL",
      userId: null
    }));
    const firstPage = pageSchema.parse(await firstResponse.json());
    const driftedReservation = fixture[51];
    if (driftedReservation === undefined) {
      throw new Error("missing status-drift fixture");
    }
    fixture[51] = { ...driftedReservation, status: "CANCELLED" };
    const secondResponse = await GET(createReadRequest({
      cursor: firstPage.nextCursor,
      query: "drift",
      reservationId: "",
      status: "CONFIRMED",
      studyPeriod: "ALL",
      userId: null
    }));
    const secondPage = pageSchema.parse(await secondResponse.json());

    // Then: the cursor snapshot remains creation-bounded and ordered while the live count is truthful.
    expect(firstResponse.status).toBe(200);
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.items.at(-1)?.id).toBe("drift-eighth-050");
    expect(firstPage.currentTotalCount).toBe(52);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(secondResponse.status).toBe(200);
    expect(secondPage).toMatchObject({
      cutoff: firstPage.cutoff,
      currentTotalCount: 51,
      expiresAt: firstPage.expiresAt,
      items: [{ id: "drift-first-001" }],
      nextCursor: null
    });
    expect(routeMocks.reservationFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      orderBy: [{ studyPeriod: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 51,
      where: expect.objectContaining({
        createdAt: { lte: new Date(firstPage.cutoff) },
        status: "CONFIRMED",
        OR: [
          { studyPeriod: "FIRST" },
          { studyPeriod: "EIGHTH", createdAt: { gt: new Date("2026-06-16T05:00:00.000Z") } },
          { studyPeriod: "EIGHTH", createdAt: new Date("2026-06-16T05:00:00.000Z"), id: { gt: "drift-eighth-050" } }
        ]
      })
    }));
  });

  it("traverses every filtered reservation beyond the former cap with route-issued cursors", async () => {
    // Given: 127 matching rows crossing the EIGHTH/FIRST boundary at a shared timestamp.
    const fixture = [
      ...Array.from({ length: 64 }, (_unused, index) => reservationListRow({
        id: `cursor-eighth-${String(index + 1).padStart(3, "0")}`,
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        userId: `cursor-student-eighth-${String(index + 1).padStart(3, "0")}`
      })),
      ...Array.from({ length: 63 }, (_unused, index) => reservationListRow({
        id: `cursor-first-${String(index + 1).padStart(3, "0")}`,
        status: "CONFIRMED",
        studyPeriod: "FIRST",
        userId: `cursor-student-first-${String(index + 1).padStart(3, "0")}`
      }))
    ];
    routeMocks.reservationCount.mockResolvedValue(fixture.length);
    routeMocks.reservationFindMany
      .mockResolvedValueOnce(fixture.slice(0, 51))
      .mockResolvedValueOnce(fixture.slice(50, 101))
      .mockResolvedValueOnce(fixture.slice(100));
    const pageSchema = z.object({
      cutoff: z.string(),
      currentTotalCount: z.number(),
      items: z.array(z.object({ id: z.string() })),
      nextCursor: z.string().nullable()
    });
    const seenIds: string[] = [];
    let cursor: string | null = null;
    let pageCount = 0;

    // When: each page request supplies the preceding response's signed cursor without recreating it.
    do {
      const response = await GET(createReadRequest({
        cursor,
        query: "cursor",
        reservationId: "",
        status: "CONFIRMED",
        studyPeriod: "ALL",
        userId: null
      }));
      expect(response.status).toBe(200);
      const page = pageSchema.parse(await response.json());
      expect(page.cutoff).toBe("2026-06-16T05:00:00.000Z");
      expect(page.currentTotalCount).toBe(127);
      seenIds.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pageCount += 1;
    } while (cursor !== null);

    // Then: filters, cutoff, period-first ordering, and cursor tuple visit each row once and terminate.
    expect(pageCount).toBe(3);
    expect(seenIds).toEqual(fixture.map((reservation) => reservation.id));
    expect(new Set(seenIds).size).toBe(fixture.length);
    expect(routeMocks.reservationFindMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      orderBy: [{ studyPeriod: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 51,
      where: expect.objectContaining({
        createdAt: { lte: new Date("2026-06-16T05:00:00.000Z") },
        date: "2026-06-16",
        status: "CONFIRMED"
      })
    }));
    expect(routeMocks.reservationFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      orderBy: [{ studyPeriod: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 51,
      where: expect.objectContaining({
        OR: [
          { studyPeriod: "FIRST" },
          { studyPeriod: "EIGHTH", createdAt: { gt: new Date("2026-06-16T05:00:00.000Z") } },
          { studyPeriod: "EIGHTH", createdAt: new Date("2026-06-16T05:00:00.000Z"), id: { gt: "cursor-eighth-050" } }
        ]
      })
    }));
    expect(routeMocks.reservationFindMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
      orderBy: [{ studyPeriod: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 51,
      where: expect.objectContaining({
        OR: [
          { studyPeriod: "FIRST", createdAt: { gt: new Date("2026-06-16T05:00:00.000Z") } },
          { studyPeriod: "FIRST", createdAt: new Date("2026-06-16T05:00:00.000Z"), id: { gt: "cursor-first-036" } }
        ]
      })
    }));
  });

  it("returns no target when the exact reservation ID is missing", async () => {
    // Given: a missing exact ID and an unrelated general fixture.
    const generalFixture = createGeneralReservationFixture();
    const missingReservationId = "missing-deep-link-target";
    routeMocks.reservationFindMany.mockImplementation(async (input) =>
      isExactReservationLookup(input, missingReservationId) ? [] : generalFixture
    );

    // When: the missing exact ID is requested.
    const response = await GET(
      createReadRequest({
        query: "",
        reservationId: missingReservationId,
        status: "ALL",
        studyPeriod: "ALL",
        userId: null
      })
    );

    // Then: no substitute row is returned.
    expect(response.status).toBe(200);
    expect(routeMocks.reservationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 1,
        where: { id: missingReservationId }
      })
    );
    await expect(response.json()).resolves.toEqual(pagePayload([], 0));
  });

  it("rejects a malformed exact reservation ID before database lookup", async () => {
    // Given: an exact ID outside the approved identifier grammar.
    const malformedReservationId = "invalid/reservation-id";
    routeMocks.reservationFindMany.mockResolvedValue([]);

    // When: the malformed exact ID crosses the route boundary.
    const response = await GET(
      createReadRequest({
        query: "",
        reservationId: malformedReservationId,
        status: "CONFIRMED",
        studyPeriod: "ALL",
        userId: null
      })
    );

    // Then: the route returns a typed client error without querying a substitute.
    expect(response.status).toBe(400);
    expect(routeMocks.reservationFindMany).not.toHaveBeenCalled();
    expect(routeMocks.reservationFindMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: malformedReservationId }) })
    );
    await expect(response.json()).resolves.toMatchObject({ error: { code: "bad_request" } });
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
  readonly cursor?: string | null;
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
  readonly createdAt?: Date;
  readonly id: string;
  readonly status: string;
  readonly studyPeriod: StudyPeriod;
  readonly userId: string;
}): ReservationListRow {
  return {
    createdAt: input.createdAt ?? new Date("2026-06-16T05:00:00.000Z"),
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
    status: input.status,
    studyPeriod: input.studyPeriod
  });
  if (input.reservationId.length > 0) {
    params.set("reservationId", input.reservationId);
  }
  if (input.cursor !== null && input.cursor !== undefined) {
    params.set("cursor", input.cursor);
  }
  if (input.userId !== null) {
    params.set("userId", input.userId);
  }
  return new Request(`https://example.test/api/admin/reservations?${params.toString()}`);
}

function isExactReservationLookup(input: unknown, reservationId: string): boolean {
  if (typeof input !== "object" || input === null || !("where" in input)) {
    return false;
  }
  const where = input.where;
  if (
    typeof where !== "object" ||
    where === null ||
    !("id" in where)
  ) {
    return false;
  }
  return where.id === reservationId;
}

function pagePayload(items: readonly object[], currentTotalCount: number): object {
  return {
    cutoff: "2026-06-16T05:00:00.000Z",
    currentTotalCount,
    expiresAt: "2026-06-16T05:15:00.000Z",
    items,
    nextCursor: null
  };
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
