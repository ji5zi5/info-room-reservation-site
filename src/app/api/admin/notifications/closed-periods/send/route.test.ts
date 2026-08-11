import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseActor } from "@/lib/db-context";
import type { RateLimitResult } from "@/lib/rate-limit";
import type { CurrentSession, SessionUser } from "@/lib/session";

type TransactionClient = {
  readonly adminAction: { readonly create: (input: unknown) => Promise<{ readonly id: string }> };
  readonly auditLog: { readonly create: (input: unknown) => Promise<unknown> };
};
type WithDatabaseContext = (input: {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: TransactionClient) => Promise<unknown>;
}) => Promise<unknown>;

const routeMocks = vi.hoisted(() => ({
  adminActionCreate: vi.fn(),
  auditLogCreate: vi.fn(),
  databaseActorFromSessionUser: vi.fn<(user: SessionUser) => DatabaseActor>(),
  enforceAdminMutationRateLimit: vi.fn<(request: Request, userId: string) => Promise<RateLimitResult>>(),
  requireAdminSession: vi.fn<() => Promise<CurrentSession>>(),
  requireMutatingRequestSafety: vi.fn<(request: Request) => null>(),
  sendClosedPeriod: vi.fn(),
  validateRequestCsrf: vi.fn(),
  withDatabaseContext: vi.fn<WithDatabaseContext>()
}));

vi.mock("@/lib/closed-period-notification-service", () => ({
  createClosedPeriodNotificationService: () => ({ sendClosedPeriod: routeMocks.sendClosedPeriod })
}));
vi.mock("@/lib/db", () => ({ prisma: { marker: "prisma-client" } }));
vi.mock("@/lib/db-context", () => ({
  databaseActorFromSessionUser: routeMocks.databaseActorFromSessionUser,
  withDatabaseContext: routeMocks.withDatabaseContext
}));
vi.mock("@/lib/prisma-notification-repository", () => ({ prismaClosedPeriodNotificationRepository: {} }));
vi.mock("@/lib/request-csrf", () => ({
  messageForCsrfError: (reason: string) => `csrf:${reason}`,
  validateRequestCsrf: routeMocks.validateRequestCsrf
}));
vi.mock("@/lib/request-security", () => ({ requireMutatingRequestSafety: routeMocks.requireMutatingRequestSafety }));
vi.mock("@/lib/route-rate-limit", () => ({ enforceAdminMutationRateLimit: routeMocks.enforceAdminMutationRateLimit }));
vi.mock("@/lib/session", () => ({
  ForbiddenSessionError: class ForbiddenSessionError extends Error {},
  requireAdminSession: routeMocks.requireAdminSession,
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {}
}));

import { POST } from "./route";

const adminUser: SessionUser = {
  bookingStatus: "ACTIVE",
  generation: 41,
  id: "admin-exact-7",
  name: "관리자",
  restrictionReason: null,
  restrictedUntil: null,
  role: "ADMIN",
  studentNumber: "90007"
};

describe("admin closed-period notification send route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/123/test-token";
    routeMocks.requireMutatingRequestSafety.mockReturnValue(null);
    routeMocks.requireAdminSession.mockResolvedValue({ id: "session-admin", user: adminUser });
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    routeMocks.enforceAdminMutationRateLimit.mockResolvedValue({
      kind: "allowed",
      remaining: 9,
      resetAt: new Date("2026-06-16T00:01:00.000Z")
    });
    routeMocks.sendClosedPeriod.mockResolvedValue({
      delivery: { lastError: null, messageIds: ["message-1"], status: "SENT" },
      kind: "sent"
    });
    routeMocks.adminActionCreate.mockResolvedValue({ id: "action-1" });
    routeMocks.auditLogCreate.mockResolvedValue({});
    routeMocks.databaseActorFromSessionUser.mockImplementation((user) => ({ id: user.id, role: "ADMIN" }));
    routeMocks.withDatabaseContext.mockImplementation(async (input) => input.operation(transactionClient()));
  });

  it("writes both audit rows with the exact authenticated ADMIN actor", async () => {
    const response = await POST(sendRequest());

    expect(response.status).toBe(200);
    expect(routeMocks.databaseActorFromSessionUser).toHaveBeenCalledWith(adminUser);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledWith(expect.objectContaining({
      actor: { id: adminUser.id, role: "ADMIN" },
      client: { marker: "prisma-client" }
    }));
    expect(routeMocks.adminActionCreate).toHaveBeenCalledOnce();
    expect(routeMocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorId: adminUser.id })
    });
  });

  it("contains no raw protected audit model access or raw Prisma transaction boundary", () => {
    const source = readFileSync(join(process.cwd(), "src/app/api/admin/notifications/closed-periods/send/route.ts"), "utf8");

    expect(source).not.toMatch(/prisma\.(?:adminAction|auditLog)\b/u);
    expect(source).not.toContain("prisma.$transaction");
  });
});

function sendRequest(): Request {
  return new Request("http://localhost/api/admin/notifications/closed-periods/send", {
    body: JSON.stringify({ date: "2026-06-12", studyPeriod: "EIGHTH" }),
    headers: { "content-type": "application/json", origin: "http://localhost" },
    method: "POST"
  });
}

function transactionClient(): TransactionClient {
  return {
    adminAction: { create: routeMocks.adminActionCreate },
    auditLog: { create: routeMocks.auditLogCreate }
  };
}
