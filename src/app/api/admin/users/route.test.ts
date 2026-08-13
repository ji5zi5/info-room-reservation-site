import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { DatabaseActor } from "@/lib/db-context";
import type { SessionUser } from "@/lib/session";

type RequireAdmin = () => Promise<SessionUser>;
type IsNoDatabaseMockMode = () => boolean;
type GetMockAdminUsers = (input: unknown) => readonly unknown[];
type UserCount = (input: unknown) => Promise<number>;
type UserFindMany = (input: unknown) => Promise<readonly unknown[]>;
type ScopedClient = { readonly user: { readonly count: UserCount; readonly findMany: UserFindMany } };
type WithDatabaseContext = <T>(input: {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: ScopedClient) => Promise<T>;
}) => Promise<T>;

const routeMocks = vi.hoisted(() => {
  const rawUserFindMany = vi.fn<UserFindMany>();
  const rawUserCount = vi.fn<UserCount>();
  const prismaClient = { user: { count: rawUserCount, findMany: rawUserFindMany } };
  return {
    ForbiddenSessionError: class ForbiddenSessionError extends Error {},
    UnauthorizedSessionError: class UnauthorizedSessionError extends Error {},
    databaseActorFromSessionUser: vi.fn<(user: SessionUser) => DatabaseActor>(),
    getMockAdminUsers: vi.fn<GetMockAdminUsers>(),
    isNoDatabaseMockMode: vi.fn<IsNoDatabaseMockMode>(),
    mockReservationUsersById: new Map<string, unknown>(),
    prismaClient,
    rawUserCount,
    rawUserFindMany,
    requireAdmin: vi.fn<RequireAdmin>(),
    scopedUserCount: vi.fn<UserCount>(),
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
  getMockAdminUsers: routeMocks.getMockAdminUsers
}));

vi.mock("@/lib/mock-reservation-state", () => ({
  mockReservationUsersById: routeMocks.mockReservationUsersById
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T01:00:00.000Z"));
    vi.stubEnv("SESSION_SECRET", "todo-12-route-cursor-secret");
    vi.resetModules();
    routeMocks.databaseActorFromSessionUser.mockReset();
    routeMocks.getMockAdminUsers.mockReset();
    routeMocks.isNoDatabaseMockMode.mockReset();
    routeMocks.mockReservationUsersById.clear();
    routeMocks.rawUserCount.mockReset();
    routeMocks.rawUserFindMany.mockReset();
    routeMocks.requireAdmin.mockReset();
    routeMocks.scopedUserCount.mockReset();
    routeMocks.scopedUserFindMany.mockReset();
    routeMocks.withDatabaseContext.mockReset();

    routeMocks.databaseActorFromSessionUser.mockReturnValue({ id: adminUser.id, role: "ADMIN" });
    routeMocks.getMockAdminUsers.mockReturnValue([]);
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.requireAdmin.mockResolvedValue(adminUser);
    routeMocks.rawUserCount.mockResolvedValue(0);
    routeMocks.rawUserFindMany.mockResolvedValue([]);
    routeMocks.scopedUserCount.mockResolvedValue(0);
    routeMocks.scopedUserFindMany.mockResolvedValue([]);
    routeMocks.withDatabaseContext.mockImplementation(async (input) =>
      input.operation({ user: { count: routeMocks.scopedUserCount, findMany: routeMocks.scopedUserFindMany } })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("reads and maps filtered users inside the authenticated ADMIN database context", async () => {
    // Given: one user matching server-side status and search filters.
    routeMocks.scopedUserCount.mockResolvedValue(1);
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

    // When: the first bounded page is requested.
    const response = await GET(adminUsersRequest("bookingStatus=SHADOW_BANNED&query=31099"));

    // Then: the response is a strict terminal page and the database owns filtering.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.status).toBe(200);
    expect(routeMocks.databaseActorFromSessionUser).toHaveBeenCalledWith(adminUser);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledWith({
      actor: { id: adminUser.id, role: "ADMIN" },
      client: routeMocks.prismaClient,
      operation: expect.any(Function)
    });
    expect(routeMocks.scopedUserFindMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        bookingStatus: true,
        createdAt: true,
        generation: true,
        id: true,
        name: true,
        restrictedUntil: true,
        restrictionReason: true,
        role: true,
        shadowBanProfile: true,
        studentNumber: true
      },
      take: 51,
      where: {
        bookingStatus: "SHADOW_BANNED",
        createdAt: { lte: new Date("2026-08-13T01:00:00.000Z") },
        AND: [{
          OR: [
            { name: { contains: "31099", mode: "insensitive" } },
            { studentNumber: { contains: "31099", mode: "insensitive" } }
          ]
        }]
      }
    });
    expect(routeMocks.rawUserFindMany).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      cutoff: "2026-08-13T01:00:00.000Z",
      currentTotalCount: 1,
      expiresAt: "2026-08-13T01:15:00.000Z",
      items: [
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
      ],
      nextCursor: null
    });
  });

  it("returns only the exact authorized user independently of list filters", async () => {
    // Given: an exact user that would not match the unrelated list filters.
    routeMocks.scopedUserFindMany.mockResolvedValue([{
      bookingStatus: "ACTIVE",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      generation: 31,
      id: "user-127",
      name: "정확한 학생",
      restrictedUntil: null,
      restrictionReason: null,
      role: "STUDENT",
      shadowBanProfile: "NORMAL",
      studentNumber: "31127"
    }]);
    const { GET } = await import("./route");

    // When: the caller supplies the exact ID alongside conflicting filters.
    const response = await GET(adminUsersRequest("bookingStatus=BANNED&query=missing&userId=user-127"));

    // Then: only that ID is looked up and the terminal page contains that record.
    expect(routeMocks.scopedUserFindMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 1,
      where: { id: "user-127" }
    }));
    await expect(response.json()).resolves.toMatchObject({
      currentTotalCount: 1,
      items: [expect.objectContaining({ id: "user-127" })],
      nextCursor: null
    });
  });

  it("returns a deep mock user ID outside the capped list", async () => {
    // Given: the exact mock user is beyond a 100-row capped list.
    const target = {
      bookingStatus: "ACTIVE",
      generation: 31,
      id: "mock-deep-user-101",
      name: "깊은 학생",
      restrictedUntil: null,
      restrictionReason: null,
      role: "STUDENT",
      shadowBanProfile: "NORMAL",
      studentNumber: "31101"
    };
    routeMocks.mockReservationUsersById.set(target.id, target);
    routeMocks.getMockAdminUsers.mockReturnValue(Array.from({ length: 100 }, (_unused, index) => ({
      ...target,
      id: `capped-user-${index + 1}`
    })));
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);
    const { GET } = await import("./route");

    // When: an exact ID is requested with conflicting list filters.
    const response = await GET(adminUsersRequest(`bookingStatus=BANNED&query=missing&userId=${target.id}`));

    // Then: mock mode reaches the exact user rather than searching the capped list.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      currentTotalCount: 1,
      items: [expect.objectContaining({ id: target.id })],
      nextCursor: null
    });
  });

  it("paginates every non-exact mock user with a signed terminal cursor", async () => {
    // Given: 51 matching mock users, exceeding the 50-row page size and any former list cap.
    const fixture = Array.from({ length: 51 }, (_unused, index) => ({
      bookingStatus: "SHADOW_BANNED",
      generation: 31,
      id: `mock-cursor-user-${String(index + 1).padStart(3, "0")}`,
      name: `mock cursor user ${index + 1}`,
      restrictedUntil: null,
      restrictionReason: "mock cursor traversal",
      role: "STUDENT",
      shadowBanProfile: "HIGH",
      studentNumber: `31${String(index + 1).padStart(3, "0")}`
    }));
    for (const user of fixture) routeMocks.mockReservationUsersById.set(user.id, user);
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);
    const { GET } = await import("./route");
    const pageSchema = z.object({
      currentTotalCount: z.number(),
      items: z.array(z.object({ id: z.string() })),
      nextCursor: z.string().nullable()
    });

    // When: a filtered list request follows its route-issued cursor once.
    const firstResponse = await GET(adminUsersRequest("bookingStatus=SHADOW_BANNED&query=mock+cursor"));
    const firstPage = pageSchema.parse(await firstResponse.json());
    const nextCursor = firstPage.nextCursor;
    const secondResponse = await GET(adminUsersRequest(new URLSearchParams({
      bookingStatus: "SHADOW_BANNED",
      cursor: nextCursor ?? "",
      query: "mock cursor"
    }).toString()));
    const secondPage = pageSchema.parse(await secondResponse.json());

    // Then: the first page is full, both pages report all matches, and the terminal page has the remaining unique ID.
    expect(firstResponse.status).toBe(200);
    expect(routeMocks.getMockAdminUsers).not.toHaveBeenCalled();
    expect(firstPage.currentTotalCount).toBe(fixture.length);
    expect(firstPage.items).toHaveLength(50);
    expect(nextCursor).not.toBeNull();
    expect(secondResponse.status).toBe(200);
    expect(secondPage.currentTotalCount).toBe(fixture.length);
    expect(secondPage.items.map((item) => item.id)).toEqual([fixture[50]?.id]);
    expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size).toBe(fixture.length);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("returns an empty list from an empty contextual user read", async () => {
    // Given: no matching users.
    const { GET } = await import("./route");

    // When: the first page is requested.
    const response = await GET(adminUsersRequest(""));

    // Then: the terminal page remains structurally complete.
    expect(response.status).toBe(200);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledOnce();
    expect(routeMocks.scopedUserFindMany).toHaveBeenCalledOnce();
    expect(routeMocks.rawUserFindMany).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      cutoff: "2026-08-13T01:00:00.000Z",
      currentTotalCount: 0,
      expiresAt: "2026-08-13T01:15:00.000Z",
      items: [],
      nextCursor: null
    });
  });

  it("traverses every filtered user beyond the former cap with route-issued cursors", async () => {
    // Given: 127 equally-timestamped filtered users, so each continuation must use the ID tie-breaker.
    const fixture = Array.from({ length: 127 }, (_unused, index) => ({
      bookingStatus: "SHADOW_BANNED",
      createdAt: new Date("2026-08-12T00:00:00.000Z"),
      generation: 31,
      id: `cursor-user-${String(index + 1).padStart(3, "0")}`,
      name: `cursor user ${index + 1}`,
      restrictedUntil: null,
      restrictionReason: "cursor traversal",
      role: "STUDENT",
      shadowBanProfile: "HIGH",
      studentNumber: `31${String(index + 1).padStart(3, "0")}`
    }));
    routeMocks.scopedUserCount.mockResolvedValue(fixture.length);
    routeMocks.scopedUserFindMany
      .mockResolvedValueOnce(fixture.slice(0, 51))
      .mockResolvedValueOnce(fixture.slice(50, 101))
      .mockResolvedValueOnce(fixture.slice(100));
    const { GET } = await import("./route");
    const pageSchema = z.object({
      cutoff: z.string(),
      currentTotalCount: z.number(),
      items: z.array(z.object({ id: z.string() })),
      nextCursor: z.string().nullable()
    });
    const seenIds: string[] = [];
    let cursor: string | null = null;
    let pageCount = 0;

    // When: each next request reuses only the signed nextCursor issued by the preceding route response.
    do {
      const query = new URLSearchParams({ bookingStatus: "SHADOW_BANNED", query: "cursor" });
      if (cursor !== null) query.set("cursor", cursor);
      const response = await GET(adminUsersRequest(query.toString()));
      expect(response.status).toBe(200);
      const page = pageSchema.parse(await response.json());
      expect(page.cutoff).toBe("2026-08-13T01:00:00.000Z");
      expect(page.currentTotalCount).toBe(127);
      seenIds.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pageCount += 1;
    } while (cursor !== null);

    // Then: filtering, ascending tuple order, cutoff, and terminal cursor preserve every ID exactly once.
    expect(pageCount).toBe(3);
    expect(seenIds).toEqual(fixture.map((user) => user.id));
    expect(new Set(seenIds).size).toBe(fixture.length);
    expect(routeMocks.scopedUserFindMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 51,
      where: {
        AND: [{ OR: [
          { name: { contains: "cursor", mode: "insensitive" } },
          { studentNumber: { contains: "cursor", mode: "insensitive" } }
        ] }],
        bookingStatus: "SHADOW_BANNED",
        createdAt: { lte: new Date("2026-08-13T01:00:00.000Z") }
      }
    }));
    expect(routeMocks.scopedUserFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 51,
      where: expect.objectContaining({
        OR: [
          { createdAt: { gt: new Date("2026-08-12T00:00:00.000Z") } },
          { createdAt: new Date("2026-08-12T00:00:00.000Z"), id: { gt: "cursor-user-050" } }
        ]
      })
    }));
    expect(routeMocks.scopedUserFindMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 51,
      where: expect.objectContaining({
        OR: [
          { createdAt: { gt: new Date("2026-08-12T00:00:00.000Z") } },
          { createdAt: new Date("2026-08-12T00:00:00.000Z"), id: { gt: "cursor-user-100" } }
        ]
      })
    }));
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
