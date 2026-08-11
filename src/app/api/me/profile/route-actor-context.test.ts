import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionUser } from "@/lib/session";

type ProfileRouteModule = { readonly GET: () => Promise<Response> };
type DatabaseActor = { readonly id: string | null; readonly role: "ADMIN" | "STUDENT" | "SYSTEM" };
type RequireUser = () => Promise<SessionUser>;
type IsNoDatabaseMockMode = () => boolean;
type DbFindUnique = (query: unknown) => Promise<unknown>;
type DbFindMany = (query: unknown) => Promise<readonly unknown[]>;
type DatabaseTransaction = {
  readonly reservation: { readonly findMany: DbFindMany; readonly groupBy: DbFindMany };
  readonly user: { readonly findUnique: DbFindUnique };
  readonly userSanction: { readonly findMany: DbFindMany };
};
type Deferred<T> = { readonly promise: Promise<T>; readonly resolve: (value: T) => void };
type WithDatabaseContextInput = {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: DatabaseTransaction) => Promise<unknown>;
};
type WithDatabaseContext = (input: WithDatabaseContextInput) => Promise<unknown>;

const routeMocks = vi.hoisted(() => ({
  databaseActorFromSessionUser: vi.fn<(user: SessionUser) => DatabaseActor>(),
  isNoDatabaseMockMode: vi.fn<IsNoDatabaseMockMode>(),
  rawReservationFindMany: vi.fn<DbFindMany>(),
  rawReservationGroupBy: vi.fn<DbFindMany>(),
  rawSanctionFindMany: vi.fn<DbFindMany>(),
  rawUserFindUnique: vi.fn<DbFindUnique>(),
  requireUser: vi.fn<RequireUser>(),
  transactionReservationFindMany: vi.fn<DbFindMany>(),
  transactionReservationGroupBy: vi.fn<DbFindMany>(),
  transactionSanctionFindMany: vi.fn<DbFindMany>(),
  transactionUserFindUnique: vi.fn<DbFindUnique>(),
  withDatabaseContext: vi.fn<WithDatabaseContext>()
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    reservation: { findMany: routeMocks.rawReservationFindMany, groupBy: routeMocks.rawReservationGroupBy },
    user: { findUnique: routeMocks.rawUserFindUnique },
    userSanction: { findMany: routeMocks.rawSanctionFindMany }
  }
}));

vi.mock("@/lib/db-context", () => ({
  databaseActorFromSessionUser: routeMocks.databaseActorFromSessionUser,
  withDatabaseContext: routeMocks.withDatabaseContext
}));

vi.mock("@/lib/mock-dev-mode", () => ({ isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode }));

vi.mock("@/lib/session", () => ({
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {},
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

const ownDatabaseUser = {
  bookingStatus: "ACTIVE",
  generation: 31,
  name: "Student One",
  restrictedUntil: null,
  restrictionReason: null,
  role: "STUDENT",
  studentNumber: "31001"
} as const;

const crossUserDatabaseRow = {
  bookingStatus: "BANNED",
  generation: 32,
  name: "Other Student",
  restrictedUntil: new Date("2026-07-01T00:00:00.000Z"),
  restrictionReason: "other-user-only",
  role: "STUDENT",
  studentNumber: "32002"
} as const;

const contextualTransaction: DatabaseTransaction = {
  reservation: {
    findMany: routeMocks.transactionReservationFindMany,
    groupBy: routeMocks.transactionReservationGroupBy
  },
  user: { findUnique: routeMocks.transactionUserFindUnique },
  userSanction: { findMany: routeMocks.transactionSanctionFindMany }
};

describe("student profile route database actor context", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();

    routeMocks.databaseActorFromSessionUser.mockImplementation((user) => ({ id: user.id, role: "STUDENT" }));
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.requireUser.mockResolvedValue(studentUser);
    routeMocks.withDatabaseContext.mockImplementation(async (input) => input.operation(contextualTransaction));

    routeMocks.transactionUserFindUnique.mockResolvedValue(ownDatabaseUser);
    routeMocks.transactionReservationFindMany.mockResolvedValue([]);
    routeMocks.transactionReservationGroupBy.mockResolvedValue([]);
    routeMocks.transactionSanctionFindMany.mockResolvedValue([]);

    routeMocks.rawUserFindUnique.mockResolvedValue(crossUserDatabaseRow);
    routeMocks.rawReservationFindMany.mockResolvedValue([
      {
        createdAt: new Date("2026-06-16T00:01:00.000Z"),
        date: "2026-06-16",
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        updatedAt: new Date("2026-06-16T00:02:00.000Z")
      }
    ]);
    routeMocks.rawReservationGroupBy.mockResolvedValue([{ _count: { _all: 1 }, status: "CONFIRMED" }]);
    routeMocks.rawSanctionFindMany.mockResolvedValue([
      {
        createdAt: new Date("2026-06-10T00:00:00.000Z"),
        endsAt: null,
        reason: "other-user-only",
        revokedAt: null,
        startsAt: new Date("2026-06-09T00:00:00.000Z"),
        status: "ACTIVE",
        type: "ADMIN_BAN"
      }
    ]);
  });

  it("uses one exact student actor context for every protected profile read without cross-user data", async () => {
    // Given
    const { GET } = await loadProfileRoute();

    // When
    const response = await GET();

    // Then
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      currentReservations: [],
      recentReservations: [],
      recentSanctions: [],
      reservationSummary: { cancelledCount: 0, confirmedCount: 0, noShowCount: 0 },
      sanctionSummary: { activeCount: 0, permanentCount: 0, revokedCount: 0, totalCount: 0 },
      user: { name: "Student One", studentNumber: "31001" }
    });
    expect(routeMocks.databaseActorFromSessionUser).toHaveBeenCalledWith(studentUser);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledOnce();
    const contextCall = routeMocks.withDatabaseContext.mock.calls.at(0);
    const contextInput = contextCall?.[0];
    if (contextInput === undefined) {
      throw new Error("Expected one database context invocation.");
    }
    expect(contextInput.actor).toEqual({ id: studentUser.id, role: "STUDENT" });
    expect(routeMocks.transactionUserFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: studentUser.id } }));
    expect(routeMocks.transactionReservationFindMany).toHaveBeenCalledTimes(2);
    expect(routeMocks.transactionReservationGroupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: studentUser.id } }));
    expect(routeMocks.transactionSanctionFindMany).toHaveBeenCalledTimes(2);
    expect(routeMocks.rawUserFindUnique).not.toHaveBeenCalled();
    expect(routeMocks.rawReservationFindMany).not.toHaveBeenCalled();
    expect(routeMocks.rawReservationGroupBy).not.toHaveBeenCalled();
    expect(routeMocks.rawSanctionFindMany).not.toHaveBeenCalled();
  });

  it("starts all protected profile reads concurrently inside the actor context", async () => {
    // Given
    const userRead = createDeferred<unknown>();
    const currentReservationsRead = createDeferred<readonly unknown[]>();
    const recentReservationsRead = createDeferred<readonly unknown[]>();
    const reservationSummaryRead = createDeferred<readonly unknown[]>();
    const recentSanctionsRead = createDeferred<readonly unknown[]>();
    const sanctionSummaryRead = createDeferred<readonly unknown[]>();
    const allReadsStarted = createDeferred<void>();
    let startedReadCount = 0;
    const markReadStarted = (): void => {
      startedReadCount += 1;
      if (startedReadCount === 6) {
        allReadsStarted.resolve(undefined);
      }
    };
    routeMocks.transactionUserFindUnique.mockImplementation(() => {
      markReadStarted();
      return userRead.promise;
    });
    routeMocks.transactionReservationFindMany
      .mockImplementationOnce(() => {
        markReadStarted();
        return currentReservationsRead.promise;
      })
      .mockImplementationOnce(() => {
        markReadStarted();
        return recentReservationsRead.promise;
      });
    routeMocks.transactionReservationGroupBy.mockImplementation(() => {
      markReadStarted();
      return reservationSummaryRead.promise;
    });
    routeMocks.transactionSanctionFindMany
      .mockImplementationOnce(() => {
        markReadStarted();
        return recentSanctionsRead.promise;
      })
      .mockImplementationOnce(() => {
        markReadStarted();
        return sanctionSummaryRead.promise;
      });
    const { GET } = await loadProfileRoute();

    // When
    const responsePromise = GET();
    await allReadsStarted.promise;

    // Then
    expect(routeMocks.transactionUserFindUnique).toHaveBeenCalledOnce();
    expect(routeMocks.transactionReservationFindMany).toHaveBeenCalledTimes(2);
    expect(routeMocks.transactionReservationGroupBy).toHaveBeenCalledOnce();
    expect(routeMocks.transactionSanctionFindMany).toHaveBeenCalledTimes(2);
    userRead.resolve(ownDatabaseUser);
    currentReservationsRead.resolve([]);
    recentReservationsRead.resolve([]);
    reservationSummaryRead.resolve([]);
    recentSanctionsRead.resolve([]);
    sanctionSummaryRead.resolve([]);
    await expect(responsePromise).resolves.toMatchObject({ status: 200 });
  });
});

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred promise resolved before initialization.");
  };
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
