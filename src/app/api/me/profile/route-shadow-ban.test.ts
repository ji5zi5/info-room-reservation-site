import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionUser } from "@/lib/session";

type ProfileRouteModule = { readonly GET: (request: Request) => Promise<Response> };
type RequireUser = () => Promise<SessionUser>;
type IsNoDatabaseMockMode = () => boolean;
type GetMockStudentProfile = (userId: string, now: Date) => unknown;
type DbFindUnique = (query: unknown) => Promise<unknown>;
type DbFindMany = (query: unknown) => Promise<readonly unknown[]>;
type DatabaseTransaction = {
  readonly reservation: { readonly findMany: DbFindMany; readonly groupBy: DbFindMany };
  readonly user: { readonly findUnique: DbFindUnique };
  readonly userSanction: { readonly findMany: DbFindMany };
};
type WithDatabaseContextInput = { readonly operation: (transaction: DatabaseTransaction) => Promise<unknown> };
type WithDatabaseContext = (input: WithDatabaseContextInput) => Promise<unknown>;

const routeMocks = vi.hoisted(() => {
  class UnauthorizedSessionError extends Error {}
  return {
    UnauthorizedSessionError,
    getMockStudentProfile: vi.fn<GetMockStudentProfile>(),
    isNoDatabaseMockMode: vi.fn<IsNoDatabaseMockMode>(),
    reservationFindMany: vi.fn<DbFindMany>(),
    reservationGroupBy: vi.fn<DbFindMany>(),
    sanctionFindMany: vi.fn<DbFindMany>(),
    requireUser: vi.fn<RequireUser>(),
    userFindUnique: vi.fn<DbFindUnique>(),
    withDatabaseContext: vi.fn<WithDatabaseContext>()
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    reservation: { findMany: routeMocks.reservationFindMany, groupBy: routeMocks.reservationGroupBy },
    user: { findUnique: routeMocks.userFindUnique },
    userSanction: { findMany: routeMocks.sanctionFindMany }
  }
}));

vi.mock("@/lib/db-context", () => ({
  databaseActorFromSessionUser: (user: SessionUser) => ({ id: user.id, role: "STUDENT" }),
  withDatabaseContext: routeMocks.withDatabaseContext
}));

vi.mock("@/lib/mock-dev-mode", () => ({ isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode }));
vi.mock("@/lib/mock-reservation-data", () => ({ getMockStudentProfile: routeMocks.getMockStudentProfile }));
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

describe("student profile route shadow-ban masking", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.requireUser.mockResolvedValue(studentUser);
    routeMocks.reservationFindMany.mockResolvedValue([]);
    routeMocks.reservationGroupBy.mockResolvedValue([]);
    routeMocks.withDatabaseContext.mockImplementation(async (input) =>
      input.operation({
        reservation: { findMany: routeMocks.reservationFindMany, groupBy: routeMocks.reservationGroupBy },
        user: { findUnique: routeMocks.userFindUnique },
        userSanction: { findMany: routeMocks.sanctionFindMany }
      })
    );
  });

  it("masks shadow-banned database profiles as unrestricted student-facing payloads", async () => {
    routeMocks.userFindUnique.mockResolvedValue({
      bookingStatus: "SHADOW_BANNED",
      generation: 31,
      name: "Student One",
      restrictedUntil: new Date("2026-07-01T00:00:00.000Z"),
      restrictionReason: "블랙리스트",
      role: "STUDENT",
      studentNumber: "31001"
    });
    routeMocks.sanctionFindMany
      .mockResolvedValueOnce([
        {
          createdAt: new Date("2026-06-10T00:00:00.000Z"),
          endsAt: null,
          reason: "블랙리스트",
          revokedAt: null,
          startsAt: new Date("2026-06-09T00:00:00.000Z"),
          status: "ACTIVE",
          type: "ADMIN_BAN"
        }
      ])
      .mockResolvedValueOnce([{ endsAt: null, revokedAt: null, status: "ACTIVE" }]);
    const { GET } = await loadProfileRoute();

    const response = await GET(profileRequest());

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject(maskedProfileShape);
    expect(text).not.toContain("SHADOW_BANNED");
    expect(text).not.toContain("블랙리스트");
  });

  it("passes through masked no-database mock profiles without leaking shadow-ban markers", async () => {
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);
    routeMocks.getMockStudentProfile.mockReturnValue({
      ...maskedProfileShape,
      currentReservations: [],
      recentReservations: [],
      reservationSummary: { cancelledCount: 0, confirmedCount: 0, noShowCount: 0 }
    });
    const { GET } = await loadProfileRoute();

    const response = await GET(profileRequest());

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject(maskedProfileShape);
    expect(text).not.toContain("SHADOW_BANNED");
    expect(text).not.toContain("블랙리스트");
  });
});

const maskedProfileShape = {
  effectiveStatus: "ACTIVE",
  recentSanctions: [],
  sanctionSummary: { activeCount: 0, permanentCount: 0, revokedCount: 0, totalCount: 0 },
  statusMessage: "예약 가능",
  user: {
    bookingStatus: "ACTIVE",
    restrictedUntil: null,
    restrictionReason: null
  }
} as const;

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

function profileRequest(): Request {
  return new Request("https://example.test/api/me/profile");
}
