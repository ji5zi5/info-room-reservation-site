import { beforeEach, describe, expect, it } from "vitest";

import {
  repositoryMocks,
  repositoryNow,
  resetRepositoryMocks
} from "./prisma-discord-reservation-message-test-support";
import {
  DISCORD_CLAIM_BATCH_SIZE,
  DISCORD_CLAIM_LEASE_MS,
  prismaDiscordReservationMessageRepository
} from "./prisma-discord-reservation-message-repository";

describe("Prisma Discord reservation message claims", () => {
  beforeEach(resetRepositoryMocks);

  it("claims at most 20 due v2 initial sends with an exact 120-second stale lease", async () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      initialSendAttempts: index,
      initialSendOutcome: null,
      nonce: `nonce-${index}`,
      reservationId: `reservation-${index}`
    }));
    repositoryMocks.transaction.discordReservationMessage.findMany.mockResolvedValue(rows);
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });

    const claims = await prismaDiscordReservationMessageRepository.claimInitialSends(repositoryNow);

    expect(DISCORD_CLAIM_BATCH_SIZE).toBe(20);
    expect(DISCORD_CLAIM_LEASE_MS).toBe(120_000);
    expect(repositoryMocks.transaction.discordReservationMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 20,
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              initialSendClaimedAt: { lte: new Date("2026-08-10T23:58:00.000Z") },
              initialSendStatus: "CLAIMED"
            })
          ])
        })
      })
    );
    expect(claims).toHaveLength(20);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledTimes(20);
  });

  it("claims only the requested immediate reservation row", async () => {
    repositoryMocks.transaction.discordReservationMessage.findMany.mockResolvedValue([{
      initialSendAttempts: 2,
      initialSendOutcome: null,
      nonce: "nonce-priority",
      reservationId: "reservation-priority"
    }]);
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });

    const claim = await prismaDiscordReservationMessageRepository.claimInitialSend(
      repositoryNow,
      "reservation-priority"
    );

    expect(claim).toMatchObject({
      attempts: 3,
      nonce: "nonce-priority",
      reservationId: "reservation-priority"
    });
    expect(repositoryMocks.transaction.discordReservationMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 1,
        where: expect.objectContaining({ reservationId: "reservation-priority" })
      })
    );
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ reservationId: "reservation-priority" })
      })
    );
  });

  it("claims at most 20 due v2 message revisions with the same lease", async () => {
    repositoryMocks.transaction.discordReservationMessage.findMany.mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => ({
        channelId: "channel",
        guildId: "guild",
        messageId: `message-${index}`,
        messageRevision: 2,
        reservationId: `reservation-${index}`,
        syncAttempts: 0,
        syncedRevision: 1
      }))
    );
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });

    const claims = await prismaDiscordReservationMessageRepository.claimMessageSyncs(repositoryNow);

    expect(claims).toHaveLength(20);
    expect(repositoryMocks.transaction.discordReservationMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 20,
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              syncClaimedAt: { lte: new Date("2026-08-10T23:58:00.000Z") },
              syncStatus: "CLAIMED"
            })
          ])
        })
      })
    );
  });

  it("claims only the requested source-message revision with the same ownership checks", async () => {
    repositoryMocks.transaction.discordReservationMessage.findMany.mockResolvedValue([{
      channelId: "channel",
      guildId: "guild",
      messageId: "message",
      messageRevision: 3,
      reservationId: "reservation-priority",
      syncAttempts: 1,
      syncedRevision: 2
    }]);
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });

    const claim = await prismaDiscordReservationMessageRepository.claimMessageSync(
      repositoryNow,
      "reservation-priority"
    );

    expect(claim).toMatchObject({ attempts: 2, reservationId: "reservation-priority", revision: 3 });
    expect(repositoryMocks.transaction.discordReservationMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 1,
        where: expect.objectContaining({ reservationId: "reservation-priority" })
      })
    );
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ messageRevision: 3, reservationId: "reservation-priority" })
      })
    );
  });

  it("moves committed legacy transport claims to review instead of reclaiming them", async () => {
    repositoryMocks.transaction.discordReservationMessage.updateMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 3 });

    const result = await prismaDiscordReservationMessageRepository.reconcileLegacyDiscordTransportClaims();

    expect(result).toEqual({ initialSendCount: 2, syncCount: 3 });
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenNthCalledWith(1, {
      data: { initialSendNextAttemptAt: null, initialSendStatus: "PENDING_REVIEW", pendingReviewReason: "LEGACY_SENDING" },
      where: { initialSendStatus: "SENDING" }
    });
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenNthCalledWith(2, {
      data: { pendingReviewReason: "LEGACY_SYNCING", syncNextAttemptAt: null, syncStatus: "PENDING_REVIEW" },
      where: { syncStatus: "SYNCING" }
    });
  });
});
