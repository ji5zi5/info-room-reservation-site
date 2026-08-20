import { describe, expect, it } from "vitest";

import {
  adaptDiscordReservationOperationCommand,
  buildDiscordRejectReasonModal,
  buildDiscordReservationCustomId,
  parseDiscordReservationInteraction
} from "./discord-interactions";

const secret = "discord-test-secret";

describe("Discord no-show reason modal", () => {
  it("parses and preserves the administrator reason when a no-show modal is submitted", () => {
    // Given: an accepted reservation's signed no-show control and a submitted reason.
    const customId = buildDiscordReservationCustomId({
      action: "no_show",
      renderedEpoch: 7,
      reservationId: "reservation-1",
      secret,
      sourceIdentity: "source-message-1"
    });
    const response = buildDiscordRejectReasonModal(customId);

    // When: Discord submits the modal payload.
    const parsed = parseDiscordReservationInteraction(modalPayload(customId, "무단 미출석"), secret);
    const command = parsed.kind === "modal_submit"
      ? adaptDiscordReservationOperationCommand({
          command: parsed.command,
          discordActorId: parsed.discordUserId,
          expectedSourceIdentity: "source-message-1",
          interactionId: parsed.interactionId,
          localActorId: "admin-1",
          sourceApplicationId: parsed.applicationId,
          sourceChannelId: parsed.channelId,
          sourceGuildId: parsed.guildId,
          sourceMessageId: parsed.messageId,
          studentNumber: "31001"
        })
      : null;

    // Then: the modal is labelled for no-show and the reason reaches the durable command.
    expect(response).toMatchObject({ data: { title: "예약 노쇼 처리 사유" }, type: 9 });
    expect(command).toMatchObject({ kind: "no_show", reason: "무단 미출석" });
  });
});

function modalPayload(customId: string, reason: string): unknown {
  return {
    application_id: "12345678901234567",
    channel_id: "12345678901234568",
    data: {
      components: [{ components: [{ custom_id: "reason", type: 4, value: reason }], type: 1 }],
      custom_id: customId
    },
    guild_id: "12345678901234569",
    id: "12345678901234570",
    member: { roles: ["12345678901234571"], user: { id: "12345678901234572" } },
    message: { id: "12345678901234573" },
    token: "interaction-token",
    type: 5
  };
}
