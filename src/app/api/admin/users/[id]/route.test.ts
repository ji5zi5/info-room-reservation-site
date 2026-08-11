import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseActor } from "@/lib/db-context";
import type { SessionUser } from "@/lib/session";

type FindUnique = (input: unknown) => Promise<UserDetailRow | null>;
type ScopedClient = { readonly user: { readonly findUnique: FindUnique } };
type WithDatabaseContext = <T>(input: {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: ScopedClient) => Promise<T>;
}) => Promise<T>;

type UserDetailRow = {
  readonly adminActionsTargeted: readonly Record<string, unknown>[];
  readonly auditLogs: readonly Record<string, unknown>[];
  readonly bookingStatus: string;
  readonly createdAt: Date;
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly reservations: readonly Record<string, unknown>[];
  readonly restrictedUntil: Date | null;
  readonly restrictionReason: string | null;
  readonly role: string;
  readonly sanctions: readonly Record<string, unknown>[];
  readonly sessions: readonly { readonly expiresAt: Date }[];
  readonly shadowBanProfile: string;
  readonly studentNumber: string;
  readonly updatedAt: Date;
};

const routeMocks = vi.hoisted(() => {
  const rawUserFindUnique = vi.fn<FindUnique>();
  const prismaClient = { user: { findUnique: rawUserFindUnique } };
  return {
    ForbiddenSessionError: class ForbiddenSessionError extends Error {},
    UnauthorizedSessionError: class UnauthorizedSessionError extends Error {},
    databaseActorFromSessionUser: vi.fn<(user: SessionUser) => DatabaseActor>(),
    isNoDatabaseMockMode: vi.fn<() => boolean>(),
    prismaClient,
    rawUserFindUnique,
    requireAdmin: vi.fn<() => Promise<SessionUser>>(),
    scopedUserFindUnique: vi.fn<FindUnique>(),
    withDatabaseContext: vi.fn<WithDatabaseContext>()
  };
});

vi.mock("@/lib/db", () => ({ prisma: routeMocks.prismaClient }));
vi.mock("@/lib/db-context", () => ({
  databaseActorFromSessionUser: routeMocks.databaseActorFromSessionUser,
  withDatabaseContext: routeMocks.withDatabaseContext
}));
vi.mock("@/lib/mock-dev-mode", () => ({ isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode }));
vi.mock("@/lib/mock-reservation-data", () => ({ getMockAdminUserDetail: vi.fn(() => null) }));
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

const detail = {
  adminActionsTargeted: [{
    action: "USER_RESTRICTION_APPLY",
    actorId: admin.id,
    after: "after",
    before: "before",
    createdAt: new Date("2026-06-15T03:00:00.000Z"),
    id: "action-1",
    reason: "관리 사유",
    reservationId: null,
    targetUserId: "student-1"
  }],
  auditLogs: [{
    action: "USER_UPDATED",
    actorId: admin.id,
    createdAt: new Date("2026-06-15T02:00:00.000Z"),
    detail: "detail",
    id: "audit-1"
  }],
  bookingStatus: "RESTRICTED",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  generation: 31,
  id: "student-1",
  name: "학생",
  reservations: [{
    createdAt: new Date("2026-06-14T01:00:00.000Z"),
    date: "2026-06-17",
    id: "reservation-1",
    reason: "자습",
    status: "CONFIRMED",
    studyPeriod: "EIGHTH",
    updatedAt: new Date("2026-06-14T01:01:00.000Z"),
    userId: "student-1"
  }],
  restrictedUntil: new Date("2026-06-20T00:00:00.000Z"),
  restrictionReason: "관리 사유",
  role: "STUDENT",
  sanctions: [{
    actorId: admin.id,
    createdAt: new Date("2026-06-15T03:00:00.000Z"),
    endsAt: new Date("2026-06-20T00:00:00.000Z"),
    id: "sanction-1",
    reason: "관리 사유",
    revokedAt: null,
    revokedById: null,
    revokedReason: null,
    sourceActionId: "action-1",
    startsAt: new Date("2026-06-15T03:00:00.000Z"),
    status: "ACTIVE",
    type: "RESTRICTED"
  }],
  sessions: [{ expiresAt: new Date("2026-06-18T00:00:00.000Z") }],
  shadowBanProfile: "NORMAL",
  studentNumber: "31001",
  updatedAt: new Date("2026-06-15T03:00:00.000Z")
} satisfies UserDetailRow;

describe("admin user detail route", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T05:00:00.000Z"));
    vi.resetAllMocks();
    routeMocks.databaseActorFromSessionUser.mockReturnValue({ id: admin.id, role: "ADMIN" });
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.rawUserFindUnique.mockResolvedValue(detail);
    routeMocks.requireAdmin.mockResolvedValue(admin);
    routeMocks.scopedUserFindUnique.mockResolvedValue(detail);
    routeMocks.withDatabaseContext.mockImplementation(async (input) =>
      input.operation({ user: { findUnique: routeMocks.scopedUserFindUnique } })
    );
  });

  it("reads and maps seeded detail inside the authenticated ADMIN database context", async () => {
    const { GET } = await import("./route");

    const response = await GET(new Request("https://example.test/api/admin/users/student-1"), routeContext());

    expect(response.status).toBe(200);
    expect(routeMocks.databaseActorFromSessionUser).toHaveBeenCalledWith(admin);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledWith({
      actor: { id: admin.id, role: "ADMIN" }, client: routeMocks.prismaClient, operation: expect.any(Function)
    });
    expect(routeMocks.scopedUserFindUnique).toHaveBeenCalledWith({
      include: {
        auditLogs: { orderBy: { createdAt: "desc" }, take: 20 },
        adminActionsTargeted: { orderBy: { createdAt: "desc" }, take: 30 },
        reservations: { orderBy: [{ date: "desc" }, { createdAt: "asc" }], take: 100 },
        sessions: { select: { expiresAt: true } },
        sanctions: { orderBy: { createdAt: "desc" }, take: 30 }
      },
      where: { id: detail.id }
    });
    expect(routeMocks.rawUserFindUnique).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      adminActions: [{ id: "action-1", targetUserId: detail.id }],
      auditLogs: [{ id: "audit-1" }],
      currentReservations: [{ id: "reservation-1" }],
      sanctionSummary: { activeCount: 1, permanentCount: 0, revokedCount: 0, totalCount: 1 },
      sessionSummary: { activeCount: 1, expiredCount: 0, totalCount: 1 },
      summary: { cancelledCount: 0, confirmedCount: 1, noShowCount: 0 },
      user: { id: detail.id, shadowBanProfile: "NORMAL", studentNumber: "31001" }
    });
  });

  it("returns not found after an empty contextual detail read", async () => {
    routeMocks.scopedUserFindUnique.mockResolvedValue(null);
    const { GET } = await import("./route");

    const response = await GET(new Request("https://example.test/api/admin/users/missing"), {
      params: Promise.resolve({ id: "missing" })
    });

    expect(response.status).toBe(404);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledOnce();
    expect(routeMocks.rawUserFindUnique).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not_found" } });
  });

  it.each([
    { code: "unauthorized", error: new routeMocks.UnauthorizedSessionError(), status: 401 },
    { code: "forbidden", error: new routeMocks.ForbiddenSessionError(), status: 403 }
  ])("preserves the $status admin session error response", async ({ code, error, status }) => {
    routeMocks.requireAdmin.mockRejectedValue(error);
    const { GET } = await import("./route");

    const response = await GET(new Request("https://example.test/api/admin/users/student-1"), routeContext());

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(routeMocks.withDatabaseContext).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected contextual detail read error", async () => {
    routeMocks.scopedUserFindUnique.mockRejectedValue(new Error("detail read failed"));
    const { GET } = await import("./route");

    await expect(
      GET(new Request("https://example.test/api/admin/users/student-1"), routeContext())
    ).rejects.toThrow("detail read failed");
    expect(routeMocks.rawUserFindUnique).not.toHaveBeenCalled();
  });
});

function routeContext(): { readonly params: Promise<{ readonly id: string }> } {
  return { params: Promise.resolve({ id: detail.id }) };
}
