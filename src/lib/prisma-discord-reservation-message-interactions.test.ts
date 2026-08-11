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
      localActorId: "admin",
      now: repositoryNow,
      reservationId: "reservation",
      revision: "PRESERVE"
    });

    expect(recorded).toBe(true);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith({
      data: {
        decidedAt: repositoryNow,
        decision: "CANCELLED",
        decisionDiscordActorId: "discord-user",
        decisionLocalActorId: "admin"
      },
      where: { decision: null, reservationId: "reservation" }
    });
  });

  it("replays the stored terminal receipt after an interaction-id conflict", async () => {
    const result = { kind: "accepted", reservationId: "reservation" };
    repositoryMocks.transaction.discordInteractionReceipt.createMany.mockResolvedValue({ count: 0 });
    repositoryMocks.transaction.discordInteractionReceipt.findUnique.mockResolvedValue({
      terminalResult: result
    });

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

  it("replays the first reservation receipt for a different interaction id", async () => {
    const result = { kind: "accepted", reservationId: "reservation" };
    repositoryMocks.transaction.discordInteractionReceipt.createMany.mockResolvedValue({ count: 0 });
    repositoryMocks.transaction.discordInteractionReceipt.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ terminalResult: result });

    const receipt = await recordDiscordInteractionReceipt(repositoryMocks.transaction, {
      discordActorId: "other-discord-user",
      interactionId: "different-interaction",
      intent: "REJECT",
      localActorId: "other-admin",
      messageId: "message",
      reservationId: "reservation",
      status: "TERMINAL",
      terminalOutcome: "CANCELLED",
      terminalResult: { kind: "cancelled", reservationId: "reservation" }
    });

    expect(receipt).toEqual({ kind: "replayed", terminalResult: result });
  });
});
