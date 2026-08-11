import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseActor } from "@/lib/db-context";
import type { SessionUser } from "@/lib/session";

type RequireAdmin = () => Promise<SessionUser>;
type IsNoDatabaseMockMode = () => boolean;
type UserFindMany = (input: unknown) => Promise<readonly unknown[]>;
type ScopedClient = { readonly user: { readonly findMany: UserFindMany } };
type WithDatabaseContext = <T>(input: {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: ScopedClient) => Promise<T>;
}) => Promise<T>;

const routeMocks = vi.hoisted(() => {
  const rawUserFindMany = vi.fn<UserFindMany>();
  const prismaClient = { user: { findMany: rawUserFindMany } };
  return {
    ForbiddenSessionError: class ForbiddenSessionError extends Error {},
    UnauthorizedSessionError: class UnauthorizedSessionError extends Error {},
    databaseActorFromSessionUser: vi.fn<(user: SessionUser) => DatabaseActor>(),
    isNoDatabaseMockMode: vi.fn<IsNoDatabaseMockMode>(),
    prismaClient,
    rawUserFindMany,
    requireAdmin: vi.fn<RequireAdmin>(),
    scopedUserFindMany: vi.fn<UserFindMany>(),
    withDatabaseContext: vi.fn<WithDatabaseContext>()
  };
});

vi.mock("@/lib/db", () => ({
  prisma: routeMocks.prismaClient
}));

vi.mock("@/lib/db-context", () => ({
  databaseActorFromSessionUser: routeMocks.databaseActorFromSessionUser,
  withDatabaseContext: routeMocks.withDatabaseContext
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode
}));

vi.mock("@/lib/mock-reservation-data", () => ({
  getMockAdminUsers: vi.fn(() => [])
}));

vi.mock("@/lib/session", () => ({
  ForbiddenSessionError: routeMocks.ForbiddenSessionError,
  UnauthorizedSessionError: routeMocks.UnauthorizedSessionError,
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
    routeMocks.databaseActorFromSessionUser.mockReset();
    routeMocks.isNoDatabaseMockMode.mockReset();
    routeMocks.rawUserFindMany.mockReset();
    routeMocks.requireAdmin.mockReset();
    routeMocks.scopedUserFindMany.mockReset();
    routeMocks.withDatabaseContext.mockReset();

    routeMocks.databaseActorFromSessionUser.mockReturnValue({ id: adminUser.id, role: "ADMIN" });
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.requireAdmin.mockResolvedValue(adminUser);
    routeMocks.rawUserFindMany.mockResolvedValue([]);
    routeMocks.scopedUserFindMany.mockResolvedValue([]);
    routeMocks.withDatabaseContext.mockImplementation(async (input) =>
      input.operation({ user: { findMany: routeMocks.scopedUserFindMany } })
    );
  });

  it("reads and maps filtered users inside the authenticated ADMIN database context", async () => {
    routeMocks.scopedUserFindMany.mockResolvedValue([
      {
        bookingStatus: "SHADOW_BANNED",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        generation: 31,
        id: "student-1",
        name: "학생",
        restrictedUntil: null,
        restrictionReason: "블랙리스트",
        riroId: "private-riro-id",
        role: "STUDENT",
        shadowBanProfile: "HIGH",
        studentNumber: "31099",
        updatedAt: new Date("2026-06-02T00:00:00.000Z")
      }
    ]);
    const { GET } = await import("./route");

    const response = await GET(adminUsersRequest("bookingStatus=SHADOW_BANNED&query=31099"));

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.status).toBe(200);
    expect(routeMocks.databaseActorFromSessionUser).toHaveBeenCalledWith(adminUser);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledWith({
      actor: { id: adminUser.id, role: "ADMIN" },
      client: routeMocks.prismaClient,
      operation: expect.any(Function)
    });
    expect(routeMocks.scopedUserFindMany).toHaveBeenCalledWith({
      orderBy: [{ bookingStatus: "desc" }, { studentNumber: "asc" }],
      select: {
        bookingStatus: true,
        generation: true,
        id: true,
        name: true,
        restrictedUntil: true,
        restrictionReason: true,
        role: true,
        shadowBanProfile: true,
        studentNumber: true
      },
      take: 100,
      where: {
        bookingStatus: "SHADOW_BANNED",
        OR: [
          { name: { contains: "31099", mode: "insensitive" } },
          { studentNumber: { contains: "31099", mode: "insensitive" } }
        ]
      }
    });
    expect(routeMocks.rawUserFindMany).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      users: [
        {
          bookingStatus: "SHADOW_BANNED",
          generation: 31,
          id: "student-1",
          name: "학생",
          restrictedUntil: null,
          restrictionReason: "블랙리스트",
          role: "STUDENT",
          shadowBanProfile: "HIGH",
          studentNumber: "31099"
        }
      ]
    });
  });

  it("returns an empty list from an empty contextual user read", async () => {
    const { GET } = await import("./route");

    const response = await GET(adminUsersRequest(""));

    expect(response.status).toBe(200);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledOnce();
    expect(routeMocks.scopedUserFindMany).toHaveBeenCalledOnce();
    expect(routeMocks.rawUserFindMany).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ users: [] });
  });

  it.each([
    { code: "unauthorized", error: new routeMocks.UnauthorizedSessionError(), status: 401 },
    { code: "forbidden", error: new routeMocks.ForbiddenSessionError(), status: 403 }
  ])("preserves the $status admin session error response", async ({ code, error, status }) => {
    routeMocks.requireAdmin.mockRejectedValue(error);
    const { GET } = await import("./route");

    const response = await GET(adminUsersRequest(""));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(routeMocks.withDatabaseContext).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected contextual user read error", async () => {
    routeMocks.scopedUserFindMany.mockRejectedValue(new Error("user read failed"));
    const { GET } = await import("./route");

    await expect(GET(adminUsersRequest(""))).rejects.toThrow("user read failed");
    expect(routeMocks.rawUserFindMany).not.toHaveBeenCalled();
  });
});

function adminUsersRequest(query: string): Request {
  return new Request(`https://example.test/api/admin/users?${query}`);
}
