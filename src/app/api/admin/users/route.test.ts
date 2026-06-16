import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionUser } from "@/lib/session";

type RequireAdmin = () => Promise<SessionUser>;
type IsNoDatabaseMockMode = () => boolean;
type UserFindMany = (input: unknown) => Promise<readonly unknown[]>;

const routeMocks = vi.hoisted(() => ({
  isNoDatabaseMockMode: vi.fn<IsNoDatabaseMockMode>(),
  requireAdmin: vi.fn<RequireAdmin>(),
  userFindMany: vi.fn<UserFindMany>()
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findMany: routeMocks.userFindMany }
  }
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode
}));

vi.mock("@/lib/mock-reservation-data", () => ({
  getMockAdminUsers: vi.fn(() => [])
}));

vi.mock("@/lib/session", () => ({
  ForbiddenSessionError: class ForbiddenSessionError extends Error {},
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {},
  requireAdmin: routeMocks.requireAdmin
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

describe("admin users route", () => {
  beforeEach(() => {
    vi.resetModules();
    routeMocks.isNoDatabaseMockMode.mockReset();
    routeMocks.requireAdmin.mockReset();
    routeMocks.userFindMany.mockReset();

    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.requireAdmin.mockResolvedValue(adminUser);
    routeMocks.userFindMany.mockResolvedValue([]);
  });

  it("pushes status and search filters into the Prisma query before the take limit", async () => {
    const { GET } = await import("./route");

    const response = await GET(adminUsersRequest("bookingStatus=SHADOW_BANNED&query=31099"));

    expect(response.status).toBe(200);
    expect(routeMocks.userFindMany).toHaveBeenCalledWith({
      orderBy: [{ bookingStatus: "desc" }, { studentNumber: "asc" }],
      take: 100,
      where: {
        bookingStatus: "SHADOW_BANNED",
        OR: [
          { name: { contains: "31099", mode: "insensitive" } },
          { studentNumber: { contains: "31099", mode: "insensitive" } }
        ]
      }
    });
  });
});

function adminUsersRequest(query: string): Request {
  return new Request(`https://example.test/api/admin/users?${query}`);
}
