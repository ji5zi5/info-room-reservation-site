import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionUser } from "@/lib/session";

type ProfileRouteModule = {
  readonly GET: (request: Request) => Promise<Response>;
};

type RequireUser = () => Promise<SessionUser>;
type IsNoDatabaseMockMode = () => boolean;
type GetMockStudentProfile = (userId: string, now: Date) => typeof safeStudentProfile | null;
type DbFindUnique = (query: unknown) => Promise<unknown>;
type DbFindMany = (query: unknown) => Promise<readonly unknown[]>;
type DbCount = (query: unknown) => Promise<number>;
type DatabaseTransaction = {
  readonly reservation: { readonly findMany: DbFindMany; readonly groupBy: DbFindMany };
  readonly user: { readonly findUnique: DbFindUnique };
  readonly userSanction: { readonly findMany: DbFindMany };
};
type WithDatabaseContextInput = { readonly operation: (transaction: DatabaseTransaction) => Promise<unknown> };
type WithDatabaseContext = (input: WithDatabaseContextInput) => Promise<unknown>;

const forbiddenSerializedKeys = [
  "userId",
  "riroId",
  "adminActions",
  "auditLogs",
  "sessionSummary",
  "actorId",
  "revokedById",
  "sourceActionId"
] as const;

const routeMocks = vi.hoisted(() => {
  class UnauthorizedSessionError extends Error {
    public constructor() {
      super("Login is required.");
      this.name = "UnauthorizedSessionError";
    }
  }

  return {
    UnauthorizedSessionError,
    getMockStudentProfile: vi.fn<GetMockStudentProfile>(),
    isNoDatabaseMockMode: vi.fn<IsNoDatabaseMockMode>(),
    reservationFindMany: vi.fn<DbFindMany>(),
    reservationGroupBy: vi.fn<DbFindMany>(),
    sanctionCount: vi.fn<DbCount>(),
    sanctionFindMany: vi.fn<DbFindMany>(),
    requireUser: vi.fn<RequireUser>(),
    userFindUnique: vi.fn<DbFindUnique>(),
    withDatabaseContext: vi.fn<WithDatabaseContext>()
  };
});

vi.mock("@/lib/db", () => ({ prisma: { reservation: { findMany: routeMocks.reservationFindMany, groupBy: routeMocks.reservationGroupBy }, user: { findUnique: routeMocks.userFindUnique }, userSanction: { count: routeMocks.sanctionCount, findMany: routeMocks.sanctionFindMany } } }));

vi.mock("@/lib/db-context", () => ({
  databaseActorFromSessionUser: (user: SessionUser) => ({ id: user.id, role: "STUDENT" }),
  withDatabaseContext: routeMocks.withDatabaseContext
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode
}));

vi.mock("@/lib/mock-reservation-data", () => ({
  getMockStudentProfile: routeMocks.getMockStudentProfile
}));

vi.mock("@/lib/session", () => ({
  UnauthorizedSessionError: routeMocks.UnauthorizedSessionError,
  requireUser: routeMocks.requireUser
}));

const studentUser: SessionUser = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "student-session-user",
  name: "Student One",
  restrictionReason: null,
  restrictedUntil: null,
  role: "STUDENT",
  studentNumber: "31001"
};

const adminUser: SessionUser = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "admin-session-user",
  name: "Admin One",
  restrictionReason: null,
  restrictedUntil: null,
  role: "ADMIN",
  studentNumber: "90000"
};

const dbStudentUser = {
  bookingStatus: "ACTIVE",
  generation: 31,
  name: "Student One",
  restrictedUntil: null,
  restrictionReason: null,
  role: "STUDENT",
  studentNumber: "31001"
} as const;

const safeStudentProfile = {
  currentReservations: [
    {
      createdAt: "2026-06-15T00:01:00.000Z",
      date: "2026-06-16",
      status: "CONFIRMED",
      studyPeriod: "EIGHTH",
      updatedAt: "2026-06-15T00:01:00.000Z"
    }
  ],
  effectiveStatus: "ACTIVE",
  recentReservations: [
    {
      createdAt: "2026-06-14T00:01:00.000Z",
      date: "2026-06-14",
      status: "CANCELLED",
      studyPeriod: "FIRST",
      updatedAt: "2026-06-14T00:03:00.000Z"
    }
  ],
  recentSanctions: [
    {
      createdAt: "2026-06-10T00:00:00.000Z",
      endsAt: "2026-06-11T00:00:00.000Z",
      reason: "Late cancellation",
      revokedAt: null,
      startsAt: "2026-06-10T00:00:00.000Z",
      status: "ACTIVE",
      type: "RESTRICTION"
    }
  ],
  reservationSummary: {
    cancelledCount: 1,
    confirmedCount: 3,
    noShowCount: 0
  },
  sanctionSummary: {
    activeCount: 1,
    permanentCount: 0,
    revokedCount: 0,
    totalCount: 1
  },
  statusMessage: "Reservation available",
  user: {
    bookingStatus: "ACTIVE",
    generation: 31,
    name: "Student One",
    restrictedUntil: null,
    restrictionReason: null,
    role: "STUDENT",
    studentNumber: "31001"
  }
} as const;

describe("student profile route", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    routeMocks.getMockStudentProfile.mockReturnValue(safeStudentProfile);
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);
    routeMocks.reservationFindMany.mockResolvedValue([]);
    routeMocks.reservationGroupBy.mockResolvedValue([]);
    routeMocks.sanctionCount.mockResolvedValue(0);
    routeMocks.sanctionFindMany.mockResolvedValue([]);
    routeMocks.requireUser.mockResolvedValue(studentUser);
    routeMocks.userFindUnique.mockResolvedValue(dbStudentUser);
    routeMocks.withDatabaseContext.mockImplementation(async (input) =>
      input.operation({
        reservation: { findMany: routeMocks.reservationFindMany, groupBy: routeMocks.reservationGroupBy },
        user: { findUnique: routeMocks.userFindUnique },
        userSanction: { findMany: routeMocks.sanctionFindMany }
      })
    );
  });

  it("returns unauthorized JSON when no student session exists", async () => {
    // Given
    routeMocks.requireUser.mockRejectedValue(new routeMocks.UnauthorizedSessionError());
    const { GET } = await loadProfileRoute();

    // When
    const response = await GET(profileRequest());

    // Then
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "unauthorized"
      }
    });
    expect(routeMocks.getMockStudentProfile).not.toHaveBeenCalled();
  });

  it("returns forbidden JSON when an admin session requests the student profile", async () => {
    // Given
    routeMocks.requireUser.mockResolvedValue(adminUser);
    const { GET } = await loadProfileRoute();

    // When
    const response = await GET(profileRequest());

    // Then
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "forbidden"
      }
    });
    expect(routeMocks.getMockStudentProfile).not.toHaveBeenCalled();
  });

  it("returns the current student's safe profile without forbidden serialized keys", async () => {
    // Given
    const { GET } = await loadProfileRoute();

    // When
    const response = await GET(profileRequest());

    // Then
    expect(response.status).toBe(200);
    const payload: unknown = await response.json();
    expect(payload).toEqual(safeStudentProfile);

    const serializedPayload = JSON.stringify(payload);
    for (const key of forbiddenSerializedKeys) {
      expect(serializedPayload).not.toContain(`"${key}"`);
    }
  });

  it("ignores attempted query userId and loads the profile for the session user", async () => {
    // Given
    const { GET } = await loadProfileRoute();

    // When
    const response = await GET(profileRequest("userId=other-student"));

    // Then
    expect(response.status).toBe(200);
    expect(routeMocks.getMockStudentProfile).toHaveBeenCalledTimes(1);
    expect(routeMocks.getMockStudentProfile).toHaveBeenCalledWith(studentUser.id, expect.any(Date));
    expect(routeMocks.getMockStudentProfile).not.toHaveBeenCalledWith("other-student", expect.any(Date));
  });

  it("uses all-time DB aggregates for summaries instead of capped recent rows", async () => {
    // Given
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    const currentReservation = { createdAt: new Date("2026-06-16T00:01:00.000Z"), date: "2026-06-16", status: "CONFIRMED", studyPeriod: "EIGHTH", updatedAt: new Date("2026-06-16T00:02:00.000Z") };
    const recentReservation = { createdAt: new Date("2026-06-10T00:01:00.000Z"), date: "2026-06-10", status: "CONFIRMED", studyPeriod: "FIRST", updatedAt: new Date("2026-06-10T00:02:00.000Z") };
    const recentSanction = { createdAt: new Date("2026-06-10T00:00:00.000Z"), endsAt: null, reason: "Late cancellation", revokedAt: null, startsAt: new Date("2026-06-09T00:00:00.000Z"), status: "ACTIVE", type: "RESERVATION" };
    const sanctionSummaryRows = [
      { endsAt: null, revokedAt: null, status: "ACTIVE" }, { endsAt: new Date("2026-06-18T00:00:00.000Z"), revokedAt: null, status: "ACTIVE" },
      { endsAt: new Date("2026-06-19T00:00:00.000Z"), revokedAt: new Date("2026-06-12T00:00:00.000Z"), status: "ACTIVE" }, { endsAt: new Date("2026-06-20T00:00:00.000Z"), revokedAt: null, status: "ACTIVE" },
      { endsAt: new Date("2026-06-21T00:00:00.000Z"), revokedAt: null, status: "REVOKED" }, { endsAt: new Date("2026-06-22T00:00:00.000Z"), revokedAt: null, status: "EXPIRED" }, { endsAt: new Date("2026-06-23T00:00:00.000Z"), revokedAt: null, status: "EXPIRED" }
    ] as const;
    routeMocks.reservationFindMany
      .mockResolvedValueOnce([currentReservation])
      .mockResolvedValueOnce([recentReservation]);
    routeMocks.reservationGroupBy.mockResolvedValue([
      { _count: { _all: 12 }, status: "CONFIRMED" },
      { _count: { _all: 3 }, status: "CANCELLED" },
      { _count: { _all: 2 }, status: "NO_SHOW" }
    ]);
    routeMocks.sanctionFindMany
      .mockResolvedValueOnce([recentSanction])
      .mockResolvedValueOnce(sanctionSummaryRows);
    routeMocks.sanctionCount
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(7);
    const { GET } = await loadProfileRoute();

    // When
    const response = await GET(profileRequest());

    // Then
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      recentReservations: [{ date: "2026-06-10" }],
      reservationSummary: { cancelledCount: 3, confirmedCount: 12, noShowCount: 2 },
      sanctionSummary: { activeCount: 4, permanentCount: 1, revokedCount: 2, totalCount: 7 }
    });
    expect(routeMocks.sanctionCount).not.toHaveBeenCalled();
    expect(routeMocks.sanctionFindMany).toHaveBeenNthCalledWith(2, { select: { endsAt: true, revokedAt: true, status: true }, where: { userId: studentUser.id } });
    expect(routeMocks.reservationGroupBy).toHaveBeenCalledWith({
      by: ["status"],
      where: { userId: studentUser.id },
      _count: { _all: true }
    });
    expect(routeMocks.reservationFindMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 10 }));
    expect(routeMocks.sanctionFindMany).toHaveBeenCalledTimes(2);
  });

});

async function loadProfileRoute(): Promise<ProfileRouteModule> {
  const routeModule: unknown = await import("./route");
  if (!isProfileRouteModule(routeModule)) {
    throw new Error("Profile route module must export GET.");
  }
  return routeModule;
}

function isProfileRouteModule(value: unknown): value is ProfileRouteModule {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "GET") === "function";
}

function profileRequest(query = ""): Request {
  const suffix = query.length > 0 ? `?${query}` : "";
  return new Request(`https://example.test/api/me/profile${suffix}`);
}
