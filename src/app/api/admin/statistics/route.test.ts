import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionUser } from "@/lib/session";

import { GET } from "./route";

type RequireAdmin = () => Promise<SessionUser>;
type IsNoDatabaseMockMode = () => boolean;
type FindMany = (query: unknown) => Promise<readonly unknown[]>;

const routeMocks = vi.hoisted(() => ({
  isNoDatabaseMockMode: vi.fn<IsNoDatabaseMockMode>(),
  periodSettingFindMany: vi.fn<FindMany>(),
  reservationFindMany: vi.fn<FindMany>(),
  requireAdmin: vi.fn<RequireAdmin>()
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    periodSetting: {
      findMany: routeMocks.periodSettingFindMany
    },
    reservation: {
      findMany: routeMocks.reservationFindMany
    }
  }
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
    routeMocks.isNoDatabaseMockMode.mockReset();
    routeMocks.periodSettingFindMany.mockReset();
    routeMocks.reservationFindMany.mockReset();
    routeMocks.requireAdmin.mockReset();

    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.periodSettingFindMany.mockResolvedValue([]);
    routeMocks.reservationFindMany.mockResolvedValue([]);
    routeMocks.requireAdmin.mockResolvedValue(adminUser);
  });

  it("returns bad request without querying Prisma when from is after to", async () => {
    const response = await GET(statisticsRequest("from=2026-06-16&to=2026-06-15"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
    expect(routeMocks.reservationFindMany).not.toHaveBeenCalled();
    expect(routeMocks.periodSettingFindMany).not.toHaveBeenCalled();
  });

  it("returns bad request without querying Prisma when the range is oversized", async () => {
    const response = await GET(statisticsRequest("from=2026-01-01&to=2026-04-15"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
    expect(routeMocks.reservationFindMany).not.toHaveBeenCalled();
    expect(routeMocks.periodSettingFindMany).not.toHaveBeenCalled();
  });

  it("returns bad request without querying Prisma when a date is not calendar-valid", async () => {
    const response = await GET(statisticsRequest("from=2026-13-01&to=2026-13-02"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
    expect(routeMocks.reservationFindMany).not.toHaveBeenCalled();
    expect(routeMocks.periodSettingFindMany).not.toHaveBeenCalled();
  });
});

function statisticsRequest(query: string): Request {
  return new Request(`https://example.test/api/admin/statistics?${query}`);
}
