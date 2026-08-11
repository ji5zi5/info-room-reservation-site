import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseActor } from "@/lib/db-context";
import type { SessionUser } from "@/lib/session";
import { GLOBAL_PERIOD_SETTINGS_DATE } from "@/lib/period-setting-values";

import { GET } from "./route";

type RequireAdmin = () => Promise<SessionUser>;
type IsNoDatabaseMockMode = () => boolean;
type FindMany = (query: unknown) => Promise<readonly unknown[]>;
type ScopedClient = {
  readonly periodSetting: { readonly findMany: FindMany };
  readonly reservation: { readonly findMany: FindMany };
};
type WithDatabaseContext = <T>(input: {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: ScopedClient) => Promise<T>;
}) => Promise<T>;

const routeMocks = vi.hoisted(() => ({
  databaseActorFromSessionUser: vi.fn<(user: SessionUser) => DatabaseActor>(),
  isNoDatabaseMockMode: vi.fn<IsNoDatabaseMockMode>(),
  rawPeriodSettingFindMany: vi.fn<FindMany>(),
  rawReservationFindMany: vi.fn<FindMany>(),
  requireAdmin: vi.fn<RequireAdmin>(),
  scopedPeriodSettingFindMany: vi.fn<FindMany>(),
  scopedReservationFindMany: vi.fn<FindMany>(),
  withDatabaseContext: vi.fn<WithDatabaseContext>()
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    periodSetting: {
      findMany: routeMocks.rawPeriodSettingFindMany
    },
    reservation: {
      findMany: routeMocks.rawReservationFindMany
    }
  }
}));

vi.mock("@/lib/db-context", () => ({
  databaseActorFromSessionUser: routeMocks.databaseActorFromSessionUser,
  withDatabaseContext: routeMocks.withDatabaseContext
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode
}));

vi.mock("@/lib/session", () => ({
  ForbiddenSessionError: class ForbiddenSessionError extends Error {},
  requireAdmin: routeMocks.requireAdmin,
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {}
}));

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

describe("admin statistics route", () => {
  beforeEach(() => {
    routeMocks.databaseActorFromSessionUser.mockReset();
    routeMocks.isNoDatabaseMockMode.mockReset();
    routeMocks.rawPeriodSettingFindMany.mockReset();
    routeMocks.rawReservationFindMany.mockReset();
    routeMocks.requireAdmin.mockReset();
    routeMocks.scopedPeriodSettingFindMany.mockReset();
    routeMocks.scopedReservationFindMany.mockReset();
    routeMocks.withDatabaseContext.mockReset();

    routeMocks.databaseActorFromSessionUser.mockReturnValue({ id: adminUser.id, role: "ADMIN" });
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.rawPeriodSettingFindMany.mockResolvedValue([]);
    routeMocks.rawReservationFindMany.mockResolvedValue([]);
    routeMocks.requireAdmin.mockResolvedValue(adminUser);
    routeMocks.scopedPeriodSettingFindMany.mockResolvedValue([]);
    routeMocks.scopedReservationFindMany.mockResolvedValue([]);
    routeMocks.withDatabaseContext.mockImplementation(async (input) =>
      input.operation({
        periodSetting: { findMany: routeMocks.scopedPeriodSettingFindMany },
        reservation: { findMany: routeMocks.scopedReservationFindMany }
      })
    );
  });

  it("returns bad request without querying Prisma when from is after to", async () => {
    const response = await GET(statisticsRequest("from=2026-06-16&to=2026-06-15"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
    expect(routeMocks.withDatabaseContext).not.toHaveBeenCalled();
  });

  it("returns bad request without querying Prisma when the range is oversized", async () => {
    const response = await GET(statisticsRequest("from=2026-01-01&to=2026-04-15"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
    expect(routeMocks.withDatabaseContext).not.toHaveBeenCalled();
  });

  it("returns bad request without querying Prisma when a date is not calendar-valid", async () => {
    const response = await GET(statisticsRequest("from=2026-13-01&to=2026-13-02"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
    expect(routeMocks.withDatabaseContext).not.toHaveBeenCalled();
  });

  it("includes global period settings when querying statistics capacity settings", async () => {
    const response = await GET(statisticsRequest("from=2026-06-16&to=2026-06-17"));

    expect(response.status).toBe(200);
    expect(routeMocks.databaseActorFromSessionUser).toHaveBeenCalledWith(adminUser);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledWith({
      actor: { id: adminUser.id, role: "ADMIN" },
      client: expect.any(Object),
      operation: expect.any(Function)
    });
    expect(routeMocks.scopedPeriodSettingFindMany).toHaveBeenCalledWith({
      select: {
        capacity: true,
        date: true,
        studyPeriod: true
      },
      where: {
        OR: [{ date: GLOBAL_PERIOD_SETTINGS_DATE }, { date: { gte: "2026-06-16", lte: "2026-06-17" } }]
      }
    });
    expect(routeMocks.scopedReservationFindMany).toHaveBeenCalledOnce();
    expect(routeMocks.rawReservationFindMany).not.toHaveBeenCalled();
    expect(routeMocks.rawPeriodSettingFindMany).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      statistics: expect.objectContaining({
        from: "2026-06-16",
        to: "2026-06-17",
        totals: expect.objectContaining({ totalCount: 0 })
      })
    });
  });

  it("calculates the empty statistics response from contextual protected reads", async () => {
    const response = await GET(statisticsRequest("from=2026-06-16&to=2026-06-16"));

    expect(response.status).toBe(200);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledOnce();
    expect(routeMocks.scopedReservationFindMany).toHaveBeenCalledOnce();
    expect(routeMocks.scopedPeriodSettingFindMany).toHaveBeenCalledOnce();
    expect(routeMocks.rawReservationFindMany).not.toHaveBeenCalled();
    expect(routeMocks.rawPeriodSettingFindMany).not.toHaveBeenCalled();
  });
});

function statisticsRequest(query: string): Request {
  return new Request(`https://example.test/api/admin/statistics?${query}`);
}
