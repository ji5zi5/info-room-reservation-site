import { describe, expect, it } from "vitest";

import type { DiscordApplicationConfig } from "./discord-app-config";
import {
  adaptDiscordReservationOperationCommand,
  authorizeDiscordPingInteraction,
  authorizeDiscordReservationInteraction,
  buildDiscordDeferredEphemeralResponse,
  buildDiscordImmediateEphemeralErrorResponse,
  buildDiscordPongResponse,
  buildDiscordRejectReasonModal,
  buildDiscordReservationCustomId,
  parseDiscordReservationInteraction
} from "./discord-interactions";

const customIdSecret = "discord-custom-id-test-secret";

const config = {
  adminRoleId: "123456789012345678",
  adminUserBindings: [{ discordUserId: "223456789012345678", studentNumber: "26001" }],
  applicationId: "423456789012345678",
  botToken: "bot-token",
  channelId: "523456789012345678",
  guildId: "623456789012345678",
  publicKey: "a".repeat(64)
} satisfies DiscordApplicationConfig;

const ledger = {
  messageId: "723456789012345678",
  reservationId: "reservation-1"
} as const;

function componentInteraction(input: {
  readonly applicationId?: string;
  readonly channelId?: string;
  readonly customId?: string;
  readonly guildId?: string;
  readonly messageId?: string;
  readonly roles?: readonly string[];
  readonly userId?: string;
} = {}) {
  return {
    application_id: input.applicationId ?? config.applicationId,
    channel_id: input.channelId ?? config.channelId,
    data: {
      component_type: 2,
      custom_id: input.customId ?? buildDiscordReservationCustomId({
        action: "accept",
        renderedEpoch: 7,
        reservationId: "reservation-1",
        secret: customIdSecret
      })
    },
    future_official_field: { supported: true },
    guild_id: input.guildId ?? config.guildId,
    id: "823456789012345678",
    member: {
      roles: input.roles ?? [config.adminRoleId],
      user: { id: input.userId ?? "223456789012345678", username: "untrusted-display-name" }
    },
    message: { id: input.messageId ?? ledger.messageId },
    token: "interaction-token",
    type: 3
  };
}

function modalInteraction(input: {
  readonly customId?: string;
  readonly messageId?: string;
  readonly reason?: string;
} = {}) {
  return {
    ...componentInteraction(input.messageId === undefined ? {} : { messageId: input.messageId }),
    data: {
      components: [{ components: [{ custom_id: "reason", type: 4, value: input.reason ?? "  운영 사유  " }], type: 1 }],
      custom_id: input.customId ?? buildDiscordReservationCustomId({
        action: "reject",
        renderedEpoch: 7,
        reservationId: "reservation-1",
        secret: customIdSecret
      })
    },
    type: 5
  };
}

describe("Discord reservation interaction contracts", () => {
  it("returns a PONG for a configured PING without requiring a ledger", () => {
    // Given: Discord's database-free PING payload from the configured application.
    const parsed = parseDiscordReservationInteraction({ application_id: config.applicationId, type: 1 }, customIdSecret);

    // When: its application binding is checked and the PING is converted into an immediate response.
    const authorization = authorizeDiscordPingInteraction({ config, interaction: parsed });
    const response = parsed.kind === "ping" ? buildDiscordPongResponse() : null;

    // Then: PING has no ledger dependency, rejects a wrong app, and returns PONG type 1.
    expect(authorization).toEqual({ kind: "authorized" });
    expect(authorizeDiscordPingInteraction({ config, interaction: parseDiscordReservationInteraction({ application_id: "999999999999999999", type: 1 }, customIdSecret) })).toEqual({ code: "wrong_application", kind: "rejected" });
    expect(parseDiscordReservationInteraction({ type: 1 }, customIdSecret)).toEqual({ kind: "invalid" });
    expect(response).toEqual({ type: 1 });
  });

  it("parses exact accept and reject buttons and builds their response contracts", () => {
    // Given: one configured accept button and one configured reject button.
    const accept = parseDiscordReservationInteraction(componentInteraction(), customIdSecret);
    const rejectId = buildDiscordReservationCustomId({ action: "reject", renderedEpoch: 7, reservationId: "reservation-1", secret: customIdSecret });
    const reject = parseDiscordReservationInteraction(componentInteraction({ customId: rejectId }), customIdSecret);

    // When: the actions are translated into Discord interaction responses.
    const acceptResponse = buildDiscordDeferredEphemeralResponse();
    const rejectResponse = buildDiscordRejectReasonModal(rejectId);

    // Then: accept defers ephemerally while reject opens a reservation-bound modal.
    expect(accept).toMatchObject({ command: { kind: "accept", renderedEpoch: 7, reservationId: "reservation-1" }, kind: "component" });
    expect(reject).toMatchObject({ command: { kind: "reject", renderedEpoch: 7, reservationId: "reservation-1" }, kind: "component" });
    expect(acceptResponse).toEqual({ data: { flags: 64 }, type: 5 });
    expect(rejectResponse).toMatchObject({
      data: {
        components: [{ components: [{ custom_id: "reason", max_length: 200, min_length: 1, required: true, type: 4 }], type: 1 }],
        custom_id: rejectId
      },
      type: 9
    });
  });

  it("parses a reservation-bound reject modal and trims its required reason", () => {
    // Given: a modal submission with a padded but valid reason.
    const parsed = parseDiscordReservationInteraction(modalInteraction(), customIdSecret);

    // When: the payload crosses the parsing boundary.
    // Then: it produces a reject command with the trimmed reason.
    expect(parsed).toMatchObject({
      command: { kind: "reject", reason: "운영 사유", renderedEpoch: 7, reservationId: "reservation-1" },
      kind: "modal_submit"
    });
  });

  it.each([
    ["unknown component", componentInteraction({ customId: "reservation:other:reservation-1" })],
    ["wrong component shape", { ...componentInteraction(), data: { custom_id: "reservation:accept:reservation-1" } }],
    ["blank reason", modalInteraction({ reason: "   " })],
    ["overlong reason", modalInteraction({ reason: "x".repeat(201) })],
    ["wrong modal action row", { ...modalInteraction(), data: { ...modalInteraction().data, components: [{ ...modalInteraction().data.components[0], type: 2 }] } }],
    ["unbound modal", modalInteraction({ customId: "reservation:accept:reservation-1" })]
  ] as const)("rejects %s as malformed input", (_scenario, interaction) => {
    // Given: a signed but unsupported or malformed Discord payload.

    // When: the payload is parsed.
    const parsed = parseDiscordReservationInteraction(interaction, customIdSecret);

    // Then: it cannot become an action command and gets an immediate ephemeral error.
    expect(parsed).toEqual({ kind: "invalid" });
    expect(buildDiscordImmediateEphemeralErrorResponse()).toEqual({
      data: { content: "요청을 처리할 수 없습니다.", flags: 64 },
      type: 4
    });
  });

  it.each([
    ["wrong application", componentInteraction({ applicationId: "999999999999999999" }), "wrong_application"],
    ["wrong guild", componentInteraction({ guildId: "999999999999999999" }), "wrong_guild"],
    ["wrong channel", componentInteraction({ channelId: "999999999999999999" }), "wrong_channel"],
    ["wrong source message", componentInteraction({ messageId: "999999999999999999" }), "wrong_source_message"],
    ["missing required role", componentInteraction({ roles: [] }), "missing_required_role"],
    ["unmapped Discord user", componentInteraction({ userId: "999999999999999999" }), "unmapped_discord_user"],
    ["wrong reservation binding", componentInteraction({ customId: buildDiscordReservationCustomId({ action: "accept", renderedEpoch: 7, reservationId: "reservation-2", secret: customIdSecret }) }), "wrong_reservation"],
    ["modal wrong source message", modalInteraction({ messageId: "999999999999999999" }), "wrong_source_message"]
  ] as const)("rejects authorization for %s", (_scenario, interaction, code) => {
    // Given: a parseable interaction that fails one authorization guard.
    const parsed = parseDiscordReservationInteraction(interaction, customIdSecret);

    // When: the configured authorization and injected ledger snapshot are applied.
    const result = authorizeDiscordReservationInteraction({ config, interaction: parsed, ledger });

    // Then: no mutation command is produced.
    expect(result).toEqual({ code, kind: "rejected" });
  });

  it("authorizes a bound administrator and emits only the trusted command fields", () => {
    // Given: a parsed reject modal from the configured guild, channel, role, user, and source message.
    const parsed = parseDiscordReservationInteraction(modalInteraction({ reason: "행사 준비" }), customIdSecret);

    // When: authorization matches the injected message ledger.
    const result = authorizeDiscordReservationInteraction({ config, interaction: parsed, ledger });

    // Then: the later mutation service receives the bound student number, never the Discord display name.
    expect(result).toEqual({
      command: {
        discordActorId: "223456789012345678",
        interactionId: "823456789012345678",
        interactionToken: "interaction-token",
        kind: "reject",
        reason: "행사 준비",
        reservationId: "reservation-1",
        sourceMessageId: "723456789012345678",
        studentNumber: "26001"
      },
      kind: "authorized"
    });
  });

  it("rejects legacy, null-epoch, oversized, and bad-MAC custom IDs before adaptation", () => {
    // Given: unauthenticated legacy IDs and corrupted v2 tuples.
    const valid = buildDiscordReservationCustomId({ action: "accept", renderedEpoch: 7, reservationId: "reservation-1", secret: customIdSecret });
    const inputs = [
      "reservation:accept:reservation-1",
      valid.replace(".7.", ".-1."),
      `${valid}x`,
      "x".repeat(101)
    ];

    // When / Then: none crosses the parser boundary into an enqueueable command.
    for (const customId of inputs) {
      expect(parseDiscordReservationInteraction(componentInteraction({ customId }), customIdSecret)).toEqual({ kind: "invalid" });
    }
  });

  it("parses accepted-state actions and adapts the verified epoch to the Todo 7 command", () => {
    // Given: current signed administrator-cancel and no-show controls.
    const cancelId = buildDiscordReservationCustomId({ action: "admin_cancel", renderedEpoch: 9, reservationId: "reservation-1", secret: customIdSecret, sourceIdentity: "source-message-1" });
    const noShowId = buildDiscordReservationCustomId({ action: "no_show", renderedEpoch: 9, reservationId: "reservation-1", secret: customIdSecret, sourceIdentity: "source-message-1" });
    const cancel = parseDiscordReservationInteraction(modalInteraction({ customId: cancelId, reason: "운영 취소" }), customIdSecret);
    const noShow = parseDiscordReservationInteraction(componentInteraction({ customId: noShowId }), customIdSecret);

    // When: trusted actor/source facts are adapted for durable enqueue.
    const adapted = cancel.kind === "modal_submit" ? adaptDiscordReservationOperationCommand({
      command: cancel.command,
      discordActorId: cancel.discordUserId,
      expectedSourceIdentity: "source-message-1",
      interactionId: cancel.interactionId,
      localActorId: "admin-1",
      sourceApplicationId: cancel.applicationId,
      sourceChannelId: cancel.channelId,
      sourceGuildId: cancel.guildId,
      sourceMessageId: cancel.messageId,
      studentNumber: "26001"
    }) : null;

    // Then: both actions retain the authenticated rendered epoch; the modal reason is preserved.
    expect(cancel).toMatchObject({ command: { kind: "admin_cancel", reason: "운영 취소", renderedEpoch: 9 } });
    expect(noShow).toMatchObject({ command: { kind: "no_show", renderedEpoch: 9 } });
    expect(adapted).toMatchObject({ kind: "admin_cancel", reason: "운영 취소", renderedControlEpoch: 9 });
  });

  it("binds the signed tuple to its source identity before producing a domain command", () => {
    const customId = buildDiscordReservationCustomId({
      action: "accept",
      renderedEpoch: 11,
      reservationId: "reservation-1",
      secret: customIdSecret,
      sourceIdentity: "source-message-1"
    });
    const parsed = parseDiscordReservationInteraction(componentInteraction({ customId }), customIdSecret);

    expect(parsed).toMatchObject({ command: { renderedEpoch: 11, sourceIdentity: "source-message-1" } });
    if (parsed.kind !== "component") throw new TypeError("expected a component interaction");
    expect(adaptDiscordReservationOperationCommand({
      command: parsed.command,
      discordActorId: parsed.discordUserId,
      expectedSourceIdentity: "different-source",
      interactionId: parsed.interactionId,
      localActorId: "admin-1",
      sourceApplicationId: parsed.applicationId,
      sourceChannelId: parsed.channelId,
      sourceGuildId: parsed.guildId,
      sourceMessageId: parsed.messageId,
      studentNumber: "26001"
    })).toBeNull();
  });
});
