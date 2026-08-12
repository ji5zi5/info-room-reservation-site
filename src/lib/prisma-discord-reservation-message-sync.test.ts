import { beforeEach, describe, expect, it } from "vitest";

import {
  repositoryMocks,
  repositoryNow,
  resetRepositoryMocks
} from "./prisma-discord-reservation-message-test-support";
import { prismaDiscordReservationMessageRepository } from "./prisma-discord-reservation-message-repository";

describe("Prisma Discord reservation message synchronization", () => {
  beforeEach(resetRepositoryMocks);

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
      decision: "ACCEPTED"
    });
    repositoryMocks.transaction.adminAction.findFirst.mockResolvedValue({ reason: "최종 취소 사유" });

    const state = await prismaDiscordReservationMessageRepository.readMessageSyncState("reservation");

    expect(state).toEqual({ cancellationReason: "최종 취소 사유", decision: "ACCEPTED" });
    expect(repositoryMocks.transaction.adminAction.findFirst).toHaveBeenCalledWith({
      orderBy: { createdAt: "desc" },
      select: { reason: true },
      where: { action: "ADMIN_RESERVATION_CANCEL", reservationId: "reservation" }
    });
  });
});
