import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseActor } from "@/lib/db-context";
import type { RateLimitResult } from "@/lib/rate-limit";
import type { CurrentSession, SessionUser } from "@/lib/session";

type UserRow = {
  readonly id: string;
  readonly role: string;
};
type SessionRow = { readonly expiresAt: Date };
type FindTarget = (input: unknown) => Promise<UserRow | null>;
type FindSessions = (input: unknown) => Promise<readonly SessionRow[]>;
type DeleteSessions = (input: unknown) => Promise<{ readonly count: number }>;
type WriteOne = (input: unknown) => Promise<{ readonly id: string }>;
type TransactionClient = {
  readonly $executeRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<number>;
  readonly adminAction: { readonly create: WriteOne };
  readonly auditLog: { readonly create: WriteOne };
  readonly session: {
    readonly deleteMany: DeleteSessions;
    readonly findMany: FindSessions;
  };
  readonly user: { readonly findUnique: FindTarget };
};
type PrismaTransaction = <T>(operation: (transaction: TransactionClient) => Promise<T>) => Promise<T>;
type WithDatabaseContext = <T>(input: {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: TransactionClient) => Promise<T>;
}) => Promise<T>;

const routeMocks = vi.hoisted(() => {
  const contextClient = {
    $executeRaw: vi.fn(async () => 1),
    adminAction: { create: vi.fn<WriteOne>() },
    auditLog: { create: vi.fn<WriteOne>() },
    session: {
      deleteMany: vi.fn<DeleteSessions>(),
      findMany: vi.fn<FindSessions>()
    },
    user: { findUnique: vi.fn<FindTarget>() }
  } satisfies TransactionClient;
  const topLevelClient = {
    $executeRaw: vi.fn(async () => 1),
    adminAction: { create: vi.fn<WriteOne>() },
    auditLog: { create: vi.fn<WriteOne>() },
    session: {
      deleteMany: vi.fn<DeleteSessions>(),
      findMany: vi.fn<FindSessions>()
    },
    user: { findUnique: vi.fn<FindTarget>() }
  } satisfies TransactionClient;
  return {
    contextClient,
    databaseActorFromSessionUser: vi.fn<(user: SessionUser) => DatabaseActor>(),
    enforceAdminMutationRateLimit: vi.fn<(request: Request, userId: string) => Promise<RateLimitResult>>(),
    requireAdminSession: vi.fn<() => Promise<CurrentSession>>(),
    requireMutatingRequestSafety: vi.fn<(request: Request) => null>(),
    topLevelTransaction: vi.fn<PrismaTransaction>(),
    topLevelUserFindUnique: vi.fn<FindTarget>(),
    topLevelClient,
    validateRequestCsrf: vi.fn<(request: Request, sessionId: string) => Promise<{ readonly kind: "ok" }>>(),
    withDatabaseContext: vi.fn<WithDatabaseContext>()
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: routeMocks.topLevelTransaction,
    user: { findUnique: routeMocks.topLevelUserFindUnique }
  }
}));

vi.mock("@/lib/db-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db-context")>();
  return {
    ...actual,
    databaseActorFromSessionUser: routeMocks.databaseActorFromSessionUser,
    withDatabaseContext: routeMocks.withDatabaseContext
  };
});

vi.mock("@/lib/request-csrf", () => ({
  messageForCsrfError: (reason: string) => `csrf:${reason}`,
  validateRequestCsrf: routeMocks.validateRequestCsrf
}));

vi.mock("@/lib/request-security", () => ({
  requireMutatingRequestSafety: routeMocks.requireMutatingRequestSafety
}));

vi.mock("@/lib/route-rate-limit", () => ({
  enforceAdminMutationRateLimit: routeMocks.enforceAdminMutationRateLimit
}));

vi.mock("@/lib/session", () => ({
  ForbiddenSessionError: class ForbiddenSessionError extends Error {},
  requireAdminSession: routeMocks.requireAdminSession,
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {}
}));

import { POST } from "./route";

const admin: SessionUser = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "admin-1",
  name: "관리자",
  restrictionReason: null,
  restrictedUntil: null,
  role: "ADMIN",
  shadowBanProfile: "NORMAL",
  studentNumber: "90000"
};

const student = { id: "student-1", role: "STUDENT" } satisfies UserRow;

describe("admin user session revoke route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    routeMocks.requireMutatingRequestSafety.mockReturnValue(null);
    routeMocks.requireAdminSession.mockResolvedValue({ id: "admin-session", user: admin });
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    routeMocks.enforceAdminMutationRateLimit.mockResolvedValue({
      kind: "allowed",
      remaining: 9,
      resetAt: new Date("2026-08-10T00:01:00.000Z")
    });
    routeMocks.databaseActorFromSessionUser.mockImplementation((user) => ({ id: user.id, role: "ADMIN" }));
    routeMocks.contextClient.user.findUnique.mockResolvedValue(student);
    routeMocks.contextClient.session.findMany.mockResolvedValue([{ expiresAt: new Date("2026-08-11T00:00:00.000Z") }]);
    routeMocks.contextClient.session.deleteMany.mockResolvedValue({ count: 1 });
    routeMocks.contextClient.adminAction.create.mockResolvedValue({ id: "action-1" });
    routeMocks.contextClient.auditLog.create.mockResolvedValue({ id: "audit-1" });
    routeMocks.withDatabaseContext.mockImplementation(async (input) => input.operation(routeMocks.contextClient));
    routeMocks.topLevelClient.user.findUnique.mockResolvedValue(student);
    routeMocks.topLevelClient.session.findMany.mockResolvedValue([{ expiresAt: new Date("2026-08-11T00:00:00.000Z") }]);
    routeMocks.topLevelClient.session.deleteMany.mockResolvedValue({ count: 1 });
    routeMocks.topLevelClient.adminAction.create.mockResolvedValue({ id: "action-1" });
    routeMocks.topLevelClient.auditLog.create.mockResolvedValue({ id: "audit-1" });
    routeMocks.topLevelTransaction.mockImplementation(async (operation) => operation(routeMocks.topLevelClient));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the exact authenticated ADMIN actor and contextual transaction client for all protected-table work", async () => {
    // Given
    const actor = { id: admin.id, role: "ADMIN" } satisfies DatabaseActor;

    // When
    const response = await POST(revokeRequest({ reason: "보안 확인" }), revokeContext(student.id));

    // Then
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      revokedSessionCount: 1,
      sessionSummary: { activeCount: 1, expiredCount: 0, totalCount: 1 }
    });
    expect(routeMocks.databaseActorFromSessionUser).toHaveBeenCalledWith(admin);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledWith({
      actor,
      client: expect.anything(),
      operation: expect.any(Function)
    });
    expect(routeMocks.topLevelTransaction).not.toHaveBeenCalled();
    expect(routeMocks.topLevelUserFindUnique).not.toHaveBeenCalled();
    expect(routeMocks.contextClient.user.findUnique).toHaveBeenCalledWith({ where: { id: student.id } });
    expect(routeMocks.contextClient.session.findMany).toHaveBeenCalledWith({
      select: { expiresAt: true },
      where: { userId: student.id }
    });
    expect(routeMocks.contextClient.session.deleteMany).toHaveBeenCalledWith({ where: { userId: student.id } });
    expect(routeMocks.contextClient.session.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      routeMocks.contextClient.adminAction.create.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(routeMocks.contextClient.adminAction.create.mock.invocationCallOrder[0]).toBeLessThan(
      routeMocks.contextClient.auditLog.create.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(routeMocks.contextClient.adminAction.create).toHaveBeenCalledWith({
      data: {
        action: "USER_SESSIONS_REVOKE",
        actorId: admin.id,
        after: JSON.stringify({ revokedSessionCount: 1 }),
        before: JSON.stringify({ activeCount: 1, expiredCount: 0, totalCount: 1 }),
        ipHash: expect.any(String),
        reason: "보안 확인",
        targetUserId: student.id
      }
    });
    expect(routeMocks.contextClient.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: "USER_SESSIONS_REVOKE",
        actorId: admin.id,
        detail: JSON.stringify({ actionId: "action-1", reason: "보안 확인", revokedSessionCount: 1 }),
        userId: student.id
      }
    });
  });

  it("returns contextual not found without any protected-table write", async () => {
    // Given
    routeMocks.contextClient.user.findUnique.mockResolvedValue(null);

    // When
    const response = await POST(revokeRequest({ reason: "대상 없음" }), revokeContext("missing-user"));

    // Then
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not_found" } });
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledOnce();
    expect(routeMocks.topLevelTransaction).not.toHaveBeenCalled();
    expect(routeMocks.contextClient.session.findMany).not.toHaveBeenCalled();
    expect(routeMocks.contextClient.session.deleteMany).not.toHaveBeenCalled();
    expect(routeMocks.contextClient.adminAction.create).not.toHaveBeenCalled();
    expect(routeMocks.contextClient.auditLog.create).not.toHaveBeenCalled();
  });

  it("returns contextual forbidden before any session or audit write", async () => {
    // Given
    routeMocks.contextClient.user.findUnique.mockResolvedValue({ id: "other-admin", role: "ADMIN" });

    // When
    const response = await POST(revokeRequest({ reason: "관리자 제외" }), revokeContext("other-admin"));

    // Then
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "admin_target" } });
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledOnce();
    expect(routeMocks.topLevelTransaction).not.toHaveBeenCalled();
    expect(routeMocks.contextClient.session.findMany).not.toHaveBeenCalled();
    expect(routeMocks.contextClient.session.deleteMany).not.toHaveBeenCalled();
    expect(routeMocks.contextClient.adminAction.create).not.toHaveBeenCalled();
    expect(routeMocks.contextClient.auditLog.create).not.toHaveBeenCalled();
  });
});

function revokeContext(id: string): { readonly params: Promise<{ readonly id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function revokeRequest(body: unknown): Request {
  return new Request("https://example.test/api/admin/users/student-1/sessions/revoke", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin: "https://example.test",
      "x-csrf-token": "csrf-token"
    },
    method: "POST"
  });
}
