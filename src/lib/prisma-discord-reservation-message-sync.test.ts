import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  repositoryMocks,
  repositoryNow,
  resetRepositoryMocks
} from "./prisma-discord-reservation-message-test-support";
import { prismaDiscordReservationMessageRepository } from "./prisma-discord-reservation-message-repository";

describe("Prisma Discord reservation message synchronization", () => {
  beforeEach(() => {
    resetRepositoryMocks();
    Object.assign(repositoryMocks.transaction, {
      $queryRaw: vi.fn().mockResolvedValue([{ enabled: true, epoch: 7, pendingRemoteCleanup: false }])
    });
  });

  it("rejects a sync save when a newer message revision superseded the claim", async () => {
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 0 });

    const saved = await prismaDiscordReservationMessageRepository.saveSyncSuccess({
      claimId: "sync-claim",
      reservationId: "reservation",
      revision: 3,
      syncedAt: repositoryNow
    });

    expect(saved).toBe(false);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ syncedRevision: 3 }),
        where: expect.objectContaining({
          messageRevision: 3,
          syncClaimId: "sync-claim",
          syncClaimRevision: 3,
          syncStatus: { in: ["CLAIMED", "PATCHING"] }
        })
      })
    );
  });

  it("bumps the revision and invalidates an active sync claim", async () => {
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });

    const bumped = await prismaDiscordReservationMessageRepository.bumpMessageRevision(
      "reservation",
      repositoryNow
    );

    expect(bumped).toBe(true);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith({
      data: {
        messageRevision: { increment: 1 },
        syncClaimId: null,
        syncClaimRevision: null,
        syncClaimedAt: null,
        syncError: null,
        syncNextAttemptAt: repositoryNow,
        syncStatus: "PENDING"
      },
      where: { reservationId: "reservation" }
    });
  });

  it("reads the latest administrator cancellation reason with the message decision", async () => {
    repositoryMocks.transaction.discordReservationMessage.findUnique.mockResolvedValue({
      decision: "ACCEPTED",
      decisionDiscordActorId: "223456789012345678",
      decisionLocalActorId: "admin-1",
      decidedAt: repositoryNow,
      nonce: "reservation-source-1",
      renderedSourceEpoch: 7
    });
    repositoryMocks.transaction.adminAction.findFirst.mockResolvedValue({ reason: "최종 취소 사유" });
    repositoryMocks.transaction.discordInteractionReceipt.findMany.mockResolvedValue([{ intent: "REJECT" }]);

    const state = await prismaDiscordReservationMessageRepository.readMessageSyncState("reservation");

    expect(state).toEqual({
      cancellationReason: "최종 취소 사유",
      decision: "ACCEPTED",
      decisionDiscordActorId: "223456789012345678",
      decisionLocalActorId: "admin-1",
      decidedAt: repositoryNow,
      nonce: "reservation-source-1",
      operationIntent: "REJECT",
      renderedSourceEpoch: 7
    });
    expect(repositoryMocks.transaction.adminAction.findFirst).toHaveBeenCalledWith({
      orderBy: { createdAt: "desc" },
      select: { reason: true },
      where: { action: { in: ["ADMIN_RESERVATION_CANCEL", "NO_SHOW_BAN"] }, reservationId: "reservation" }
    });
    expect(repositoryMocks.transaction.discordInteractionReceipt.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "desc" },
      select: { intent: true },
      take: 1,
      where: { reservationId: "reservation", status: "TERMINAL" }
    });
  });

  it("locks the operations control row and rejects PATCHING when disable advanced the epoch", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ enabled: false, epoch: 8, pendingRemoteCleanup: true }]);
    Object.assign(repositoryMocks.transaction, { $queryRaw: queryRaw });

    const registered = await prismaDiscordReservationMessageRepository.beginSyncPatch({
      claimId: "sync-claim",
      deadlineAt: new Date(repositoryNow.getTime() + 10_000),
      epoch: 7,
      operationId: "sync-operation",
      reservationId: "reservation",
      revision: 3
    });

    expect(registered).toBe(false);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).not.toHaveBeenCalled();
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const query = queryRaw.mock.calls[0]?.[0] as { readonly strings?: readonly string[] } | undefined;
    expect(query?.strings?.join("?")).toContain('FROM "DiscordOperationsControl"');
    expect(query?.strings?.join("?")).toContain("FOR SHARE");
  });

  it("moves expired PATCHING work to review without treating expiry as drained", async () => {
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 2 });

    const reconciled = await prismaDiscordReservationMessageRepository.reconcileExpiredSyncPatches(repositoryNow);

    expect(reconciled).toBe(2);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith({
      data: {
        pendingReviewReason: "PATCHING_EXPIRED",
        remoteVerificationStatus: "PENDING",
        syncNextAttemptAt: null,
        syncStatus: "PENDING_REVIEW"
      },
      where: { patchDeadlineAt: { lte: repositoryNow }, syncStatus: "PATCHING" }
    });
  });

  it("settles an already committed old-epoch PATCH without consulting a newer control epoch", async () => {
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });

    const saved = await prismaDiscordReservationMessageRepository.saveLeasedSyncSuccess({
      claimId: "sync-claim",
      epoch: 7,
      operationId: "sync-operation",
      reservationId: "reservation",
      revision: 3,
      syncedAt: repositoryNow
    });

    expect(saved).toBe(true);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ renderedSourceEpoch: 7, syncStatus: "SYNCED" }),
      where: expect.objectContaining({
        patchOperationEpoch: 7,
        patchOperationId: "sync-operation",
        syncStatus: "PATCHING"
      })
    }));
  });
});
