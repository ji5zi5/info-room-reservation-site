import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => {
  const discordReservationMessage = {
    count: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn<(input: Prisma.DiscordReservationMessageUpdateManyArgs) => Promise<Prisma.BatchPayload>>()
  };
  const transaction = {
    auditLog: { create: vi.fn() },
    discordInteractionJob: { count: vi.fn() },
    discordInteractionReceipt: { count: vi.fn() },
    discordOperationsControl: { findUnique: vi.fn() },
    discordReservationMessage
  };
  return {
    transaction,
    withDatabaseContext: vi.fn(async (input: { readonly operation: (value: typeof transaction) => Promise<unknown> }) =>
      input.operation(transaction)
    )
  };
});

vi.mock("./db", () => ({ prisma: { kind: "prisma" } }));
vi.mock("./db-context", () => ({
  systemDatabaseActor: () => ({ id: null, role: "SYSTEM" }),
  withDatabaseContext: repositoryMocks.withDatabaseContext
}));

import {
  getPrismaDiscordReadinessState,
  prismaDiscordReservationMaintenanceRepository
} from "./prisma-discord-reservation-maintenance-repository";

const now = new Date("2026-08-11T00:00:00.000Z");
const candidate = {
  channelId: "channel",
  expiresAt: new Date("2026-08-10T00:00:00.000Z"),
  messageId: "message",
  reservationId: "reservation",
  updatedAt: new Date("2026-08-10T01:00:00.000Z")
};

describe("Prisma Discord maintenance repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repositoryMocks.transaction.discordReservationMessage.findMany.mockResolvedValue([]);
    repositoryMocks.transaction.discordReservationMessage.count.mockResolvedValue(0);
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 0 });
    repositoryMocks.transaction.discordReservationMessage.deleteMany.mockResolvedValue({ count: 0 });
    repositoryMocks.transaction.discordInteractionJob.count.mockResolvedValue(0);
    repositoryMocks.transaction.discordInteractionReceipt.count.mockResolvedValue(0);
    repositoryMocks.transaction.discordOperationsControl.findUnique.mockResolvedValue({ enabled: true });
  });

  it("claims only unexpired undecided sent bot messages with a stale-lease recovery path", async () => {
    // Given: one eligible active bot message.
    repositoryMocks.transaction.discordReservationMessage.findMany.mockResolvedValue([{
      channelId: "channel",
      messageId: "message",
      messageRevision: 2,
      reservationId: "reservation"
    }]);
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });

    // When: rollback candidates are claimed.
    const claims = await prismaDiscordReservationMaintenanceRepository.claimActiveMessagesForDisable(now);

    // Then: active filters and the exact revision guard the claim.
    expect(claims).toHaveLength(1);
    expect(repositoryMocks.transaction.discordReservationMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 20,
      where: expect.objectContaining({
        decision: null,
        expiresAt: { gt: now },
        initialSendStatus: "SENT",
        messageId: { not: null },
        OR: expect.arrayContaining([{ syncClaimedAt: { lte: new Date("2026-08-10T23:58:00.000Z") }, syncStatus: "SYNCING" }])
      })
    }));
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ messageRevision: 2, reservationId: "reservation" })
    }));
  });

  it("marks controls disabled only while the rollback owns the unchanged message revision", async () => {
    // Given: the rollback still owns its claim.
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });
    const claim = { channelId: "channel", claimId: "claim", messageId: "message", reservationId: "reservation", revision: 2 };

    // When: the remote edit is completed.
    const completed = await prismaDiscordReservationMaintenanceRepository.completeDisableClaim(claim, now);

    // Then: the durable decision prevents interactions and future controls-bearing sync.
    expect(completed).toBe(true);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({ decision: "DISABLED", syncStatus: "SYNCED", syncedRevision: 2 }),
      where: expect.objectContaining({
        decision: null,
        messageRevision: 2,
        syncClaimId: "claim",
        syncStatus: "SYNCING"
      })
    });
  });

  it("classifies bounded known, unknown, and pointer-free expired candidates", async () => {
    const base = {
      initialSendOutcome: null,
      initialSendStatus: "SENT",
      nonce: "nonce",
      postOperationBoundary: null,
      remoteVerificationCursor: null,
      remoteVerificationStatus: null
    };
    repositoryMocks.transaction.discordReservationMessage.findMany.mockResolvedValue([
      { ...candidate, ...base },
      {
        ...candidate,
        ...base,
        initialSendOutcome: "UNKNOWN",
        initialSendStatus: "PENDING_REVIEW",
        messageId: null,
        postOperationBoundary: "boundary",
        remoteVerificationCursor: JSON.stringify(continuation("PARTIAL")),
        remoteVerificationStatus: "PARTIAL",
        reservationId: "unknown"
      },
      { ...candidate, ...base, messageId: null, reservationId: "local" }
    ]);
    repositoryMocks.transaction.discordReservationMessage.deleteMany.mockResolvedValue({ count: 1 });

    const candidates = await prismaDiscordReservationMaintenanceRepository.findExpiredCandidates(now);
    const localCandidate = candidates[2];
    if (localCandidate === undefined) throw new Error("Expected local retention candidate");
    const deleted = await prismaDiscordReservationMaintenanceRepository.deleteLocalCandidate(localCandidate, now);

    expect(candidates.map((row) => row.kind)).toEqual(["known", "unknown", "local"]);
    expect(candidates[1]?.continuation).toEqual(continuation("PARTIAL"));
    expect(deleted).toBe(true);
    expect(repositoryMocks.transaction.discordReservationMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 101,
      where: expect.objectContaining({ expiresAt: { lte: now }, AND: expect.any(Array) })
    }));
    expect(repositoryMocks.transaction.discordReservationMessage.deleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lte: now },
        initialSendStatus: { in: ["SENT", "ABANDONED"] },
        messageId: null,
        remoteVerificationStatus: null,
        reservationId: "local",
        syncStatus: { in: ["SYNCED", "ABANDONED"] },
        updatedAt: candidate.updatedAt
      }
    });
  });

  it("persists resumable cursor evidence while compacting an unresolved tombstone", async () => {
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });
    const unresolved = { ...candidate, attemptBoundary: "boundary", continuation: null, kind: "unknown" as const, messageId: null, nonce: "nonce" };

    const saved = await prismaDiscordReservationMaintenanceRepository.saveScanProgress(
      unresolved,
      continuation("ZERO_COMPLETE"),
      now
    );

    expect(saved).toBe(true);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        guildId: null,
        initialSendOutcome: "UNKNOWN",
        initialSendStatus: "PENDING_REVIEW",
        remoteVerificationCursor: JSON.stringify(continuation("ZERO_COMPLETE")),
        remoteVerificationStatus: "ZERO_COMPLETE",
        syncStatus: "ABANDONED"
      }),
      where: expect.objectContaining({ reservationId: "reservation", updatedAt: candidate.updatedAt })
    });
  });

  it("reduces the ledger before writing a redacted multiple-match security audit in one transaction", async () => {
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });
    repositoryMocks.transaction.auditLog.create.mockResolvedValue({ id: "audit" });
    const known = { ...candidate, attemptBoundary: null, continuation: null, kind: "known" as const, nonce: "nonce" };

    const reduced = await prismaDiscordReservationMaintenanceRepository.reduceToDeletionTombstone({
      candidate: known,
      matchCount: 2,
      now,
      outcome: "MULTIPLE"
    });

    expect(reduced).toBe(true);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        messageId: null,
        remoteVerificationCursor: null,
        remoteVerificationStatus: "RETENTION_DELETED"
      })
    }));
    expect(repositoryMocks.transaction.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: "DISCORD_RETENTION_MULTIPLE_MESSAGES_DELETED",
        detail: JSON.stringify({ matchCount: 2, outcome: "MULTIPLE", reservationId: "reservation" })
      }
    });
  });

  it("reads independent Discord retention blockers without selecting applicant data", async () => {
    repositoryMocks.transaction.discordInteractionJob.count.mockResolvedValue(2);
    repositoryMocks.transaction.discordInteractionReceipt.count.mockResolvedValue(3);
    repositoryMocks.transaction.discordReservationMessage.count.mockResolvedValue(4);

    const state = await getPrismaDiscordReadinessState(now);

    expect(state).toEqual({
      interactionsEnabled: true,
      interactionsRetentionBacklogCount: 5,
      reservationOutboxRetentionBacklogCount: 4
    });
    expect(repositoryMocks.transaction.discordReservationMessage.count).toHaveBeenCalledWith({
      where: {
        expiresAt: { lte: now },
        OR: [
          { remoteVerificationStatus: null },
          { remoteVerificationStatus: { not: "RETENTION_DELETED" } }
        ]
      }
    });
  });
});

function continuation(status: "PARTIAL" | "ZERO_COMPLETE") {
  return {
    attemptBoundary: "boundary",
    before: "cursor",
    complete: status === "ZERO_COMPLETE",
    lastErrorCode: null,
    matchedMessageIds: status === "PARTIAL" ? ["message"] : [],
    pagesScanned: 1,
    status,
    version: 1 as const
  };
}
