import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DiscordBotClient,
  DiscordChannelHistoryClient,
  DiscordGuildMemberClient
} from "@/lib/discord-bot";
import type { RateLimitResult } from "@/lib/rate-limit";
import { UnauthorizedSessionError, type CurrentSession, type SessionUser } from "@/lib/session";

const routeMocks = vi.hoisted(() => ({
  enforceAdminMutationRateLimit: vi.fn(),
  repair: vi.fn(),
  requireAdminSession: vi.fn(),
  requireMutatingRequestSafety: vi.fn(),
  validateRequestCsrf: vi.fn(),
  verify: vi.fn()
}));

vi.mock("@/lib/prisma-discord-reservation-message-repository", () => ({
  createPrismaDiscordRemoteVerificationRepository: vi.fn(() => ({ kind: "repository" })),
  repairDiscordReservationMessageWithPrisma: routeMocks.repair
}));
vi.mock("@/lib/discord-reservation-reconciliation", () => ({
  verifyRemoteDiscordReservationMessage: routeMocks.verify
}));
vi.mock("@/lib/discord-interaction-authorization", () => ({
  authorizeCurrentDiscordReservationActor: vi.fn(),
  isCurrentDiscordReservationSource: vi.fn()
}));
vi.mock("@/lib/discord-notifications", () => ({ sendDiscordWebhook: vi.fn() }));
vi.mock("@/lib/discord-reservation-snapshot", () => ({ loadDiscordReservationSnapshot: vi.fn() }));
vi.mock("@/lib/prisma-notification-settings", () => ({ getPrismaNotificationSettings: vi.fn() }));
vi.mock("@/lib/reservation-created-notification-service", () => ({
  sendReservationCreatedNotification: vi.fn()
}));
vi.mock("@/lib/discord-reservation-operations", () => ({ processDiscordReservationOperation: vi.fn() }));
vi.mock("@/lib/discord-bot", () => ({ createDiscordBotClient: vi.fn(() => ({ kind: "transport" })) }));
vi.mock("@/lib/db-context", () => ({
  databaseActorFromSessionUser: (user: SessionUser) => ({ id: user.id, role: "ADMIN" })
}));
vi.mock("@/lib/env", () => ({
  parseServerEnv: () => ({
    discordApplication: { applicationId: "application-1", botToken: "bot-token" }
  })
}));
vi.mock("@/lib/request-csrf", () => ({
  messageForCsrfError: (reason: string) => `csrf:${reason}`,
  validateRequestCsrf: routeMocks.validateRequestCsrf
}));
vi.mock("@/lib/request-security", () => ({ requireMutatingRequestSafety: routeMocks.requireMutatingRequestSafety }));
vi.mock("@/lib/request-source", () => ({ hashRequestClientIp: () => "ip-hash" }));
vi.mock("@/lib/route-rate-limit", () => ({ enforceAdminMutationRateLimit: routeMocks.enforceAdminMutationRateLimit }));
vi.mock("@/lib/session", () => ({
  ForbiddenSessionError: class ForbiddenSessionError extends Error {},
  requireAdminSession: routeMocks.requireAdminSession,
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {}
}));

import { POST } from "./route";
import { createDelegatingDiscordBotClient } from "@/lib/discord-reservation-outbox-runtime";

const admin: SessionUser = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "admin-1",
  name: "관리자",
  restrictionReason: null,
  restrictedUntil: null,
  role: "ADMIN",
  studentNumber: "90000"
};
const allowed: RateLimitResult = {
  kind: "allowed",
  remaining: 9,
  resetAt: new Date("2026-08-13T00:01:00.000Z")
};

describe("admin Discord reservation reconciliation route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    routeMocks.requireMutatingRequestSafety.mockReturnValue(null);
    routeMocks.requireAdminSession.mockResolvedValue({ id: "session-1", user: admin } satisfies CurrentSession);
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    routeMocks.enforceAdminMutationRateLimit.mockResolvedValue(allowed);
    routeMocks.repair.mockResolvedValue({ auditActionId: "action-1", kind: "repaired" });
    routeMocks.verify.mockResolvedValue({ kind: "unresolved", status: "ZERO_COMPLETE" });
  });

  it("runs one epoch-bound remote verification without accepting Discord secrets", async () => {
    // Given / When: an administrator submits the strict verification DTO.
    const response = await POST(request({
      action: "verify_remote",
      expectedControlEpoch: 7,
      expectedState: "PENDING_REVIEW",
      reservationId: "reservation-1"
    }));

    // Then: the bounded verifier runs and returns truthful unresolved state.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: { kind: "unresolved", status: "ZERO_COMPLETE" } });
    expect(routeMocks.verify).toHaveBeenCalledWith(expect.objectContaining({
      expectedControlEpoch: 7,
      reservationId: "reservation-1"
    }));
    expect(JSON.stringify(routeMocks.verify.mock.calls)).not.toContain("bot-token");
  });

  it.each(["retry", "sync"])("delegates safe %s repair with expected state and epoch", async (action) => {
    const response = await POST(request({
      action,
      expectedControlEpoch: 7,
      expectedState: action === "retry" ? "FAILED" : "RETRY:2:1:7",
      reservationId: "reservation-1"
    }));

    expect(response.status).toBe(200);
    expect(routeMocks.repair).toHaveBeenCalledWith(expect.objectContaining({
      action,
      expectedControlEpoch: 7,
      expectedState: expect.any(String),
      reservationId: "reservation-1"
    }));
  });

  it.each(["remove_controls", "abandon"])("requires reservation-bound confirmation for destructive %s", async (action) => {
    const response = await POST(request({
      action,
      expectedControlEpoch: 7,
      expectedState: "ABANDONED",
      reservationId: "reservation-1"
    }));

    expect(response.status).toBe(400);
    expect(routeMocks.repair).not.toHaveBeenCalled();
  });

  it.each(["delete", "VERIFY_REMOTE", ""])("rejects unsupported action %s", async (action) => {
    const response = await POST(request({
      action,
      expectedControlEpoch: 7,
      expectedState: "PENDING_REVIEW",
      reservationId: "reservation-1"
    }));

    expect(response.status).toBe(400);
    expect(routeMocks.repair).not.toHaveBeenCalled();
    expect(routeMocks.verify).not.toHaveBeenCalled();
  });

  it("rejects CSRF before rate limiting or repair", async () => {
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "error", reason: "csrf_invalid" });
    const response = await POST(request({
      action: "retry",
      expectedControlEpoch: 7,
      expectedState: "FAILED",
      reservationId: "reservation-1"
    }));

    expect(response.status).toBe(403);
    expect(routeMocks.enforceAdminMutationRateLimit).not.toHaveBeenCalled();
    expect(routeMocks.repair).not.toHaveBeenCalled();
  });

  it("rejects unsafe cross-site requests before session lookup", async () => {
    routeMocks.requireMutatingRequestSafety.mockReturnValue({
      code: "origin_forbidden",
      message: "forbidden"
    });

    const response = await POST(request({
      action: "retry",
      expectedControlEpoch: 7,
      expectedState: "FAILED",
      reservationId: "reservation-1"
    }));

    expect(response.status).toBe(403);
    expect(routeMocks.requireAdminSession).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests before CSRF or repair", async () => {
    routeMocks.requireAdminSession.mockRejectedValue(new UnauthorizedSessionError());

    const response = await POST(request({
      action: "retry",
      expectedControlEpoch: 7,
      expectedState: "FAILED",
      reservationId: "reservation-1"
    }));

    expect(response.status).toBe(401);
    expect(routeMocks.validateRequestCsrf).not.toHaveBeenCalled();
    expect(routeMocks.repair).not.toHaveBeenCalled();
  });

  it("rate limits administrators before repair", async () => {
    routeMocks.enforceAdminMutationRateLimit.mockResolvedValue({
      kind: "blocked",
      limit: 20,
      resetAt: new Date("2026-08-13T00:01:00.000Z")
    });

    const response = await POST(request({
      action: "retry",
      expectedControlEpoch: 7,
      expectedState: "FAILED",
      reservationId: "reservation-1"
    }));

    expect(response.status).toBe(429);
    expect(routeMocks.repair).not.toHaveBeenCalled();
  });

  it("returns conflict for stale or concurrently repaired rows without claiming success", async () => {
    routeMocks.repair.mockResolvedValue({ code: "stale_state", kind: "conflict" });
    const response = await POST(request({
      action: "retry",
      expectedControlEpoch: 7,
      expectedState: "FAILED",
      reservationId: "reservation-1"
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "notification_state_conflict" } });
  });

  it("delegates one bounded channel-history page through the current bot configuration", async () => {
    // Given: runtime configuration and a narrow bot-client factory.
    const listChannelMessagesPage = vi.fn(async () => ({ kind: "found" as const, messages: [] }));
    const client = {
      createChannelMessage: vi.fn(),
      deleteChannelMessage: vi.fn(),
      editChannelMessage: vi.fn(),
      editOriginalEphemeralResponse: vi.fn(),
      getGuildMember: vi.fn(),
      listChannelMessagesPage
    } satisfies DiscordBotClient & DiscordGuildMemberClient & DiscordChannelHistoryClient;
    const createClient = vi.fn(() => client);
    const runtime = createDelegatingDiscordBotClient(
      () => ({
        adminRoleId: "role-1",
        adminUserBindings: [],
        applicationId: "application-1",
        botToken: "bot-token",
        channelId: "channel-1",
        guildId: "guild-1",
        publicKey: "public-key"
      }),
      createClient
    );

    // When: reconciliation asks the runtime for one history page.
    const result = await runtime.listChannelMessagesPage({ before: "message-9", channelId: "channel-1", limit: 25 });

    // Then: the current configuration creates one client and receives the exact bounded request.
    expect(result).toEqual({ kind: "found", messages: [] });
    expect(createClient).toHaveBeenCalledWith({ applicationId: "application-1", botToken: "bot-token" });
    expect(listChannelMessagesPage).toHaveBeenCalledWith({
      before: "message-9",
      channelId: "channel-1",
      limit: 25
    });
  });
});

function request(body: unknown): Request {
  return new Request("https://example.test/api/admin/discord/reservations/reconcile", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin: "https://example.test",
      "x-csrf-token": "csrf-token"
    },
    method: "POST"
  });
}
