import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionUser } from "@/lib/session";

const routeMocks = vi.hoisted(() => ({
  getDiscordOperationsBacklog: vi.fn(),
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/prisma-discord-reservation-message-repository", () => ({
  getDiscordOperationsBacklog: routeMocks.getDiscordOperationsBacklog
}));
vi.mock("@/lib/db-context", () => ({
  databaseActorFromSessionUser: (user: SessionUser) => ({ id: user.id, role: "ADMIN" })
}));
vi.mock("@/lib/session", () => ({
  ForbiddenSessionError: class ForbiddenSessionError extends Error {},
  requireAdmin: routeMocks.requireAdmin,
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {}
}));

import { GET } from "./route";

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

describe("admin operations route", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    routeMocks.requireAdmin.mockResolvedValue(admin);
    routeMocks.getDiscordOperationsBacklog.mockResolvedValue(snapshot());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("returns independent job health and all three bounded backlog classes through the strict DTO", async () => {
    // Given / When: an authenticated administrator reads the command-center data.
    const response = await GET(new Request("https://example.test/api/admin/operations"));
    const body = await response.json();

    // Then: missing and failed jobs stay independent and every backlog exposes rows plus aggregate truth.
    expect(response.status).toBe(200);
    expect(body.jobs).toEqual([
      expect.objectContaining({ health: { code: "never_run", status: "unready" }, job: "CLOSED_PERIOD_NOTIFICATIONS" }),
      expect.objectContaining({ health: { code: "last_attempt_failed", status: "degraded" }, job: "DISCORD_INTERACTIONS" }),
      expect.objectContaining({ health: { code: "healthy", status: "ok" }, job: "DISCORD_RESERVATION_OUTBOX" })
    ]);
    expect(body.backlogs.interactions).toMatchObject({ count: 4, oldestAgeMs: 7_200_000 });
    expect(body.backlogs.initialSends.items[0]).toMatchObject({
      latestAuditActionId: "audit-initial",
      permittedActions: ["verify_remote", "abandon"],
      reservationId: "reservation-initial",
      userId: "user-initial"
    });
    expect(body.backlogs.syncs.items[0]).toMatchObject({
      latestAuditActionId: "audit-sync",
      permittedActions: ["remove_controls"],
      reservationId: "reservation-sync",
      userId: "user-sync"
    });
    expect(JSON.stringify(body)).not.toContain("bot-token");
    expect(JSON.stringify(body)).not.toContain("webhook");
  });

  it("rejects unknown query parameters instead of silently widening the operations read", async () => {
    const response = await GET(new Request("https://example.test/api/admin/operations?limit=10000"));

    expect(response.status).toBe(400);
    expect(routeMocks.getDiscordOperationsBacklog).not.toHaveBeenCalled();
  });
});

function snapshot() {
  const failedAt = new Date("2026-08-12T23:59:00.000Z");
  const successAt = new Date("2026-08-12T23:59:30.000Z");
  return {
    control: { enabled: true, epoch: 7, pendingRemoteCleanup: false },
    initialSends: {
      count: 3,
      oldestAgeMs: 3_600_000,
      rows: [{
        createdAt: new Date("2026-08-12T23:00:00.000Z"),
        initialSendAttempts: 1,
        initialSendOutcome: "UNKNOWN",
        initialSendStatus: "PENDING_REVIEW",
        messageId: null,
        remoteVerificationStatus: "ZERO_COMPLETE",
        reservation: { adminActions: [{ id: "audit-initial" }], status: "CONFIRMED", userId: "user-initial" },
        reservationId: "reservation-initial",
        updatedAt: new Date("2026-08-12T23:30:00.000Z")
      }]
    },
    interactions: {
      count: 4,
      oldestAgeMs: 7_200_000,
      rows: [{
        attempts: 2,
        createdAt: new Date("2026-08-12T22:00:00.000Z"),
        errorCode: "discord_http_500",
        interactionId: "interaction-1",
        reservation: { adminActions: [], userId: "user-interaction" },
        reservationId: "reservation-interaction",
        status: "RETRY",
        updatedAt: failedAt
      }]
    },
    jobs: [
      {
        backlogCount: 4,
        consecutiveFailures: 1,
        durationMs: 10,
        failureCode: "discord_http_500",
        finishedAt: failedAt,
        job: "DISCORD_INTERACTIONS",
        lastAttemptAt: failedAt,
        lastSuccessAt: new Date("2026-08-12T23:58:00.000Z"),
        oldestBacklogAt: new Date("2026-08-12T22:00:00.000Z"),
        result: null,
        startedAt: failedAt,
        status: "FAILED"
      },
      {
        backlogCount: 0,
        consecutiveFailures: 0,
        durationMs: 5,
        failureCode: null,
        finishedAt: successAt,
        job: "DISCORD_RESERVATION_OUTBOX",
        lastAttemptAt: successAt,
        lastSuccessAt: successAt,
        oldestBacklogAt: null,
        result: "{}",
        startedAt: successAt,
        status: "SUCCEEDED"
      }
    ],
    syncs: {
      count: 2,
      oldestAgeMs: 1_800_000,
      rows: [{
        createdAt: new Date("2026-08-12T23:30:00.000Z"),
        messageId: "message-sync",
        messageRevision: 2,
        renderedSourceEpoch: 7,
        reservation: { adminActions: [{ id: "audit-sync" }], status: "CANCELLED", userId: "user-sync" },
        reservationId: "reservation-sync",
        syncStatus: "RETRY",
        syncedRevision: 1,
        updatedAt: failedAt
      }]
    }
  };
}
