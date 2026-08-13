import { beforeEach, describe, expect, it } from "vitest";

import {
  repositoryMocks,
  repositoryNow,
  resetRepositoryMocks
} from "./prisma-discord-reservation-message-test-support";
import {
  recordDiscordInteractionReceipt,
  recordDiscordReservationDecision
} from "./prisma-discord-reservation-message-repository";

describe("Prisma Discord reservation message interaction writes", () => {
  beforeEach(resetRepositoryMocks);

  it("records rejection decision metadata without a second revision bump", async () => {
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });

    const recorded = await recordDiscordReservationDecision(repositoryMocks.transaction, {
      decision: "CANCELLED",
      discordActorId: "discord-user",
      expectedDecision: null,
      localActorId: "admin",
      now: repositoryNow,
      reservationId: "reservation",
      renderedSourceEpoch: 7,
      revision: "PRESERVE",
      sourceMessageId: "message"
    });

    expect(recorded).toBe(true);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith({
      data: {
        decidedAt: repositoryNow,
        decision: "CANCELLED",
        decisionDiscordActorId: "discord-user",
        decisionLocalActorId: "admin"
      },
      where: {
        decision: null,
        messageId: "message",
        renderedSourceEpoch: 7,
        reservationId: "reservation"
      }
    });
  });

  it("compares accepted source state, message identity, and rendered epoch for a follow-up transition", async () => {
    // Given
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });

    // When
    await recordDiscordReservationDecision(repositoryMocks.transaction, {
      decision: "NO_SHOW",
      discordActorId: "discord-user",
      expectedDecision: "ACCEPTED",
      localActorId: "admin",
      now: repositoryNow,
      reservationId: "reservation",
      renderedSourceEpoch: 9,
      revision: "INCREMENT",
      sourceMessageId: "source-message"
    });

    // Then
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        decision: "ACCEPTED",
        messageId: "source-message",
        renderedSourceEpoch: 9,
        reservationId: "reservation"
      }
    }));
  });

  it("replays the stored terminal receipt after an interaction-id conflict", async () => {
    const result = { kind: "accepted", reservationId: "reservation" };
    const storedReceipt = { reservationId: "reservation", status: "TERMINAL", terminalResult: result };
    repositoryMocks.transaction.discordInteractionReceipt.createMany.mockResolvedValue({ count: 0 });
    repositoryMocks.transaction.discordInteractionReceipt.findUnique.mockResolvedValue(storedReceipt);

    const receipt = await recordDiscordInteractionReceipt(repositoryMocks.transaction, {
      discordActorId: "discord-user",
      interactionId: "interaction",
      intent: "ACCEPT",
      localActorId: "admin",
      messageId: "message",
      reservationId: "reservation",
      status: "TERMINAL",
      terminalOutcome: "ACCEPTED",
      terminalResult: result
    });

    expect(receipt).toEqual({ kind: "replayed", terminalResult: result });
  });

  it("rejects an interaction replay bound to another reservation", async () => {
    const result = { kind: "accepted", reservationId: "other-reservation" };
    const storedReceipt = { reservationId: "other-reservation", status: "TERMINAL", terminalResult: result };
    repositoryMocks.transaction.discordInteractionReceipt.createMany.mockResolvedValue({ count: 0 });
    repositoryMocks.transaction.discordInteractionReceipt.findUnique.mockResolvedValue(storedReceipt);

    await expect(recordDiscordInteractionReceipt(repositoryMocks.transaction, {
      discordActorId: "discord-user", interactionId: "interaction", intent: "ACCEPT",
      localActorId: "admin", messageId: "message", reservationId: "reservation", status: "TERMINAL",
      terminalOutcome: "ACCEPTED", terminalResult: result
    })).rejects.toThrow("interaction");
  });

  it("does not replay a different interaction receipt for the same reservation", async () => {
    repositoryMocks.transaction.discordInteractionReceipt.createMany.mockResolvedValue({ count: 0 });
    repositoryMocks.transaction.discordInteractionReceipt.findUnique.mockResolvedValue(null);

    await expect(recordDiscordInteractionReceipt(repositoryMocks.transaction, {
      discordActorId: "other-discord-user", interactionId: "different-interaction", intent: "REJECT",
      localActorId: "other-admin", messageId: "message", reservationId: "reservation", status: "TERMINAL",
      terminalOutcome: "CANCELLED", terminalResult: { kind: "cancelled", reservationId: "reservation" }
    })).rejects.toThrow("different-interaction");
    expect(repositoryMocks.transaction.discordInteractionReceipt.findUnique).toHaveBeenCalledTimes(1);
  });
});
