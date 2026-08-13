import { beforeEach, describe, expect, it } from "vitest";

import {
  repositoryMocks,
  repositoryNow,
  resetRepositoryMocks
} from "./prisma-discord-reservation-message-test-support";
import {
  cappedDiscordRetryAt,
  prismaDiscordReservationMessageRepository
} from "./prisma-discord-reservation-message-repository";

describe("Prisma Discord reservation message initial sends", () => {
  beforeEach(resetRepositoryMocks);

  it("marks webhook delivery started only while the caller owns the send claim", async () => {
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });

    const marked = await prismaDiscordReservationMessageRepository.beginInitialSendTerminalDelivery({
      claimId: "claim",
      outcome: "WEBHOOK_FALLBACK_STARTED",
      reservationId: "reservation"
    });

    expect(marked).toBe(true);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith({
      data: {
        initialSendOutcome: "WEBHOOK_FALLBACK_STARTED",
        initialSendStatus: "POSTING",
        postOperationBoundary: "WEBHOOK_FALLBACK_STARTED",
        postOperationId: "claim"
      },
      where: {
        initialSendClaimId: "claim",
        initialSendStatus: "CLAIMED",
        reservationId: "reservation"
      }
    });
  });

  it("rejects an initial-send save after its claim has been replaced", async () => {
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 0 });

    const saved = await prismaDiscordReservationMessageRepository.saveInitialSendSuccess({
      channelId: "channel",
      claimId: "stale-claim",
      guildId: "guild",
      messageId: "message",
      renderedSourceEpoch: 7,
      reservationId: "reservation",
      sentAt: repositoryNow
    });

    expect(saved).toBe(false);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledTimes(2);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany.mock.calls.map(([write]) => write.where))
      .toEqual([
        {
          initialSendClaimId: "stale-claim",
          initialSendStatus: "POSTING",
          messageRevision: 0,
          reservationId: "reservation"
        },
        {
          initialSendClaimId: "stale-claim",
          initialSendStatus: "POSTING",
          messageRevision: { gt: 0 },
          reservationId: "reservation"
        }
      ]);
  });

  it("persists the rendered epoch when the initial revision is current", async () => {
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValueOnce({ count: 1 });

    const saved = await prismaDiscordReservationMessageRepository.saveInitialSendSuccess({
      channelId: "channel",
      claimId: "claim",
      guildId: "guild",
      messageId: "message",
      renderedSourceEpoch: 7,
      reservationId: "reservation",
      sentAt: repositoryNow
    });

    expect(saved).toBe(true);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ renderedSourceEpoch: 7, syncStatus: "SYNCED" }),
        where: expect.objectContaining({ initialSendClaimId: "claim", messageRevision: 0 })
      })
    );
  });

  it("queues a sync when the reservation revision changes during the initial send", async () => {
    repositoryMocks.transaction.discordReservationMessage.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    const saved = await prismaDiscordReservationMessageRepository.saveInitialSendSuccess({
      channelId: "channel",
      claimId: "claim",
      guildId: "guild",
      messageId: "message",
      renderedSourceEpoch: 7,
      reservationId: "reservation",
      sentAt: repositoryNow
    });

    expect(saved).toBe(true);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          renderedSourceEpoch: 7,
          syncNextAttemptAt: repositoryNow,
          syncStatus: "PENDING"
        }),
        where: expect.objectContaining({ initialSendClaimId: "claim", messageRevision: { gt: 0 } })
      })
    );
  });

  it("caps retry scheduling at 60 minutes", () => {
    expect(cappedDiscordRetryAt(repositoryNow, 1)).toEqual(new Date("2026-08-11T00:01:00.000Z"));
    expect(cappedDiscordRetryAt(repositoryNow, 20)).toEqual(new Date("2026-08-11T01:00:00.000Z"));
  });
});
