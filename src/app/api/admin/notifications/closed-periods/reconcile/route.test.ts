import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RateLimitResult } from "@/lib/rate-limit";
import type { CurrentSession, SessionUser } from "@/lib/session";

type AdminActionCreate = (input: unknown) => Promise<{ readonly id: string }>;
type AuditLogCreate = (input: unknown) => Promise<unknown>;
type ReconcileResult =
  | {
      readonly delivery: {
        readonly date: string;
        readonly kind: string;
        readonly status: "SENT";
        readonly studyPeriod: "EIGHTH";
      };
      readonly kind: "confirmed";
      readonly previousStatus: "UNKNOWN";
    }
  | { readonly kind: "conflict" };
type ReconcileClosedPeriod = (input: unknown) => Promise<ReconcileResult>;
type TransactionClient = {
  readonly adminAction: { readonly create: AdminActionCreate };
  readonly auditLog: { readonly create: AuditLogCreate };
};
type PrismaTransaction = <T>(operation: (transaction: TransactionClient) => Promise<T>) => Promise<T>;
type RequireAdminSession = () => Promise<CurrentSession>;
type ValidateRequestCsrf = (
  request: Request,
  sessionId: string
) => Promise<{ readonly kind: "error"; readonly reason: "csrf_invalid" } | { readonly kind: "ok" }>;

const routeMocks = vi.hoisted(() => ({
  adminActionCreate: vi.fn<AdminActionCreate>(),
  auditLogCreate: vi.fn<AuditLogCreate>(),
  enforceAdminMutationRateLimit:
    vi.fn<(request: Request, userId: string) => Promise<RateLimitResult>>(),
  reconcileClosedPeriod: vi.fn<ReconcileClosedPeriod>(),
  requireAdminSession: vi.fn<RequireAdminSession>(),
  requireMutatingRequestSafety: vi.fn<(request: Request) => null>(),
  sendDiscordWebhook: vi.fn(),
  transaction: vi.fn<PrismaTransaction>(),
  validateRequestCsrf: vi.fn<ValidateRequestCsrf>()
}));

vi.mock("@/lib/closed-period-notification-service", () => ({
  createClosedPeriodNotificationService: () => ({
    reconcileClosedPeriod: routeMocks.reconcileClosedPeriod
  })
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: routeMocks.transaction
  }
}));

vi.mock("@/lib/discord-notifications", () => ({
  sendDiscordWebhook: routeMocks.sendDiscordWebhook
}));

vi.mock("@/lib/prisma-notification-repository", () => ({
  prismaClosedPeriodNotificationRepository: {}
}));

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

import { UnauthorizedSessionError } from "@/lib/session";

import { POST } from "./route";

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

const allowedRateLimit: RateLimitResult = {
  kind: "allowed",
  remaining: 9,
  resetAt: new Date("2026-06-16T00:01:00.000Z")
};

describe("admin closed-period notification reconciliation route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/123/test-token";
    routeMocks.requireMutatingRequestSafety.mockReturnValue(null);
    routeMocks.requireAdminSession.mockResolvedValue({ id: "session-admin", user: adminUser });
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    routeMocks.enforceAdminMutationRateLimit.mockResolvedValue(allowedRateLimit);
    routeMocks.reconcileClosedPeriod.mockResolvedValue(confirmedResult());
    routeMocks.adminActionCreate.mockResolvedValue({ id: "action-1" });
    routeMocks.auditLogCreate.mockResolvedValue({});
    routeMocks.transaction.mockImplementation(async (operation) => operation(transactionClient()));
  });

  it("confirms an unknown delivery and audits only the winning transition", async () => {
    const response = await POST(reconcileRequest("confirm_sent"));

    expect(response.status).toBe(200);
    expect(routeMocks.reconcileClosedPeriod).toHaveBeenCalledWith({
      action: "confirm_sent",
      date: "2026-06-12",
      studyPeriod: "EIGHTH"
    });
    expect(routeMocks.sendDiscordWebhook).not.toHaveBeenCalled();
    expect(routeMocks.adminActionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CLOSED_LIST_NOTIFICATION_RECONCILE",
        actorId: adminUser.id,
        ipHash: expect.any(String),
        reason: "마감 명단 전송 완료 확인"
      })
    });
    expect(routeMocks.auditLogCreate).toHaveBeenCalledWith({
      data: {
        action: "CLOSED_LIST_NOTIFICATION_RECONCILE",
        actorId: adminUser.id,
        detail: JSON.stringify({
          actionId: "action-1",
          date: "2026-06-12",
          operation: "confirm_sent",
          studyPeriod: "EIGHTH"
        })
      }
    });
  });

  it("requires a configured webhook only for explicit retry", async () => {
    delete process.env.DISCORD_WEBHOOK_URL;

    const response = await POST(reconcileRequest("retry"));

    expect(response.status).toBe(500);
    expect(routeMocks.reconcileClosedPeriod).not.toHaveBeenCalled();
  });

  it("returns conflict without audit rows when another action already won", async () => {
    routeMocks.reconcileClosedPeriod.mockResolvedValue({ kind: "conflict" });

    const response = await POST(reconcileRequest("abandon"));

    expect(response.status).toBe(409);
    expect(routeMocks.adminActionCreate).not.toHaveBeenCalled();
    expect(routeMocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("rejects malformed reconciliation actions before calling the service", async () => {
    const response = await POST(reconcileRequest("delete_everything"));

    expect(response.status).toBe(400);
    expect(routeMocks.reconcileClosedPeriod).not.toHaveBeenCalled();
  });

  it("rejects invalid CSRF before rate limiting or reconciling", async () => {
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "error", reason: "csrf_invalid" });

    const response = await POST(reconcileRequest("abandon"));

    expect(response.status).toBe(403);
    expect(routeMocks.enforceAdminMutationRateLimit).not.toHaveBeenCalled();
    expect(routeMocks.reconcileClosedPeriod).not.toHaveBeenCalled();
  });

  it("rejects blocked administrators before reconciling", async () => {
    routeMocks.enforceAdminMutationRateLimit.mockResolvedValue({
      kind: "blocked",
      limit: 10,
      resetAt: new Date("2026-06-16T00:01:00.000Z")
    });

    const response = await POST(reconcileRequest("abandon"));

    expect(response.status).toBe(429);
    expect(routeMocks.reconcileClosedPeriod).not.toHaveBeenCalled();
  });

  it("returns unauthorized without calling mutation guards downstream", async () => {
    routeMocks.requireAdminSession.mockRejectedValue(new UnauthorizedSessionError());

    const response = await POST(reconcileRequest("abandon"));

    expect(response.status).toBe(401);
    expect(routeMocks.validateRequestCsrf).not.toHaveBeenCalled();
    expect(routeMocks.reconcileClosedPeriod).not.toHaveBeenCalled();
  });
});

function confirmedResult(): Exclude<ReconcileResult, { readonly kind: "conflict" }> {
  return {
    delivery: {
      date: "2026-06-12",
      kind: "CLOSED_LIST",
      status: "SENT",
      studyPeriod: "EIGHTH"
    },
    kind: "confirmed",
    previousStatus: "UNKNOWN"
  };
}

function reconcileRequest(action: string): Request {
  return new Request("http://localhost/api/admin/notifications/closed-periods/reconcile", {
    body: JSON.stringify({
      action,
      date: "2026-06-12",
      studyPeriod: "EIGHTH"
    }),
    headers: {
      "content-type": "application/json",
      origin: "http://localhost"
    },
    method: "POST"
  });
}

function transactionClient(): TransactionClient {
  return {
    adminAction: { create: routeMocks.adminActionCreate },
    auditLog: { create: routeMocks.auditLogCreate }
  };
}
