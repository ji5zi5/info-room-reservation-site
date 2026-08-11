import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseActor } from "@/lib/db-context";
import type { SessionUser } from "@/lib/session";

type FindMany = (input: unknown) => Promise<readonly AdminActionRow[]>;
type ScopedClient = { readonly adminAction: { readonly findMany: FindMany } };
type WithDatabaseContext = <T>(input: {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: ScopedClient) => Promise<T>;
}) => Promise<T>;
type AdminActionRow = {
  readonly action: string;
  readonly actor: { readonly id: string; readonly name: string; readonly studentNumber: string } | null;
  readonly actorId: string;
  readonly after: string | null;
  readonly before: string | null;
  readonly createdAt: Date;
  readonly id: string;
  readonly reason: string | null;
  readonly reservationId: string | null;
  readonly targetUser: { readonly id: string; readonly name: string; readonly studentNumber: string } | null;
  readonly targetUserId: string | null;
};

const routeMocks = vi.hoisted(() => {
  const rawAdminActionFindMany = vi.fn<FindMany>();
  const prismaClient = { adminAction: { findMany: rawAdminActionFindMany } };
  return {
    ForbiddenSessionError: class ForbiddenSessionError extends Error {},
    UnauthorizedSessionError: class UnauthorizedSessionError extends Error {},
    databaseActorFromSessionUser: vi.fn<(user: SessionUser) => DatabaseActor>(),
    isNoDatabaseMockMode: vi.fn<() => boolean>(),
    prismaClient,
    rawAdminActionFindMany,
    requireAdmin: vi.fn<() => Promise<SessionUser>>(),
    scopedAdminActionFindMany: vi.fn<FindMany>(),
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
vi.mock("@/lib/mock-dev-mode", () => ({ isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode }));
vi.mock("@/lib/session", () => ({
  ForbiddenSessionError: routeMocks.ForbiddenSessionError,
  UnauthorizedSessionError: routeMocks.UnauthorizedSessionError,
  requireAdmin: routeMocks.requireAdmin
}));

const admin = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "admin-1",
  name: "관리자",
  restrictionReason: null,
  restrictedUntil: null,
  role: "ADMIN",
  studentNumber: "90000"
} satisfies SessionUser;

const action = {
  action: "USER_RESTRICTION_APPLY",
  actor: { id: admin.id, name: admin.name, studentNumber: admin.studentNumber },
  actorId: admin.id,
  after: "after",
  before: "before",
  createdAt: new Date("2026-06-16T03:00:00.000Z"),
  id: "action-1",
  reason: "관리 사유",
  reservationId: null,
  targetUser: { id: "student-1", name: "학생", studentNumber: "31001" },
  targetUserId: "student-1"
} satisfies AdminActionRow;

describe("admin actions route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    routeMocks.databaseActorFromSessionUser.mockReturnValue({ id: admin.id, role: "ADMIN" });
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.rawAdminActionFindMany.mockResolvedValue([action]);
    routeMocks.requireAdmin.mockResolvedValue(admin);
    routeMocks.scopedAdminActionFindMany.mockResolvedValue([action]);
    routeMocks.withDatabaseContext.mockImplementation(async (input) =>
      input.operation({ adminAction: { findMany: routeMocks.scopedAdminActionFindMany } })
    );
  });

  it("reads, filters, and maps seeded actions inside the authenticated ADMIN database context", async () => {
    const { GET } = await import("./route");

    const response = await GET(actionsRequest("action=RESTRICTION&query=31001&limit=1"));

    expect(response.status).toBe(200);
    expect(routeMocks.databaseActorFromSessionUser).toHaveBeenCalledWith(admin);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledWith({
      actor: { id: admin.id, role: "ADMIN" }, client: routeMocks.prismaClient, operation: expect.any(Function)
    });
    expect(routeMocks.scopedAdminActionFindMany).toHaveBeenCalledWith({
      include: {
        actor: { select: { id: true, name: true, studentNumber: true } },
        targetUser: { select: { id: true, name: true, studentNumber: true } }
      },
      orderBy: { createdAt: "desc" },
      take: 200
    });
    expect(routeMocks.rawAdminActionFindMany).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      actions: [{ ...action, category: "RESTRICTION", createdAt: action.createdAt.toISOString() }]
    });
  });

  it("returns an empty list from an empty contextual action read", async () => {
    routeMocks.scopedAdminActionFindMany.mockResolvedValue([]);
    const { GET } = await import("./route");

    const response = await GET(actionsRequest(""));

    expect(response.status).toBe(200);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledOnce();
    expect(routeMocks.scopedAdminActionFindMany).toHaveBeenCalledOnce();
    expect(routeMocks.rawAdminActionFindMany).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ actions: [] });
  });

  it.each([
    { code: "unauthorized", error: new routeMocks.UnauthorizedSessionError(), status: 401 },
    { code: "forbidden", error: new routeMocks.ForbiddenSessionError(), status: 403 }
  ])("preserves the $status admin session error response", async ({ code, error, status }) => {
    routeMocks.requireAdmin.mockRejectedValue(error);
    const { GET } = await import("./route");

    const response = await GET(actionsRequest(""));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(routeMocks.withDatabaseContext).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected contextual action read error", async () => {
    routeMocks.scopedAdminActionFindMany.mockRejectedValue(new Error("action read failed"));
    const { GET } = await import("./route");

    await expect(GET(actionsRequest(""))).rejects.toThrow("action read failed");
    expect(routeMocks.rawAdminActionFindMany).not.toHaveBeenCalled();
  });
});

function actionsRequest(query: string): Request {
  return new Request(`https://example.test/api/admin/actions?${query}`);
}
