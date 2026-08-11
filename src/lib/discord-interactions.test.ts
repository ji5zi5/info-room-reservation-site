import { describe, expect, it } from "vitest";

import type { DiscordApplicationConfig } from "./discord-app-config";
import {
  authorizeDiscordPingInteraction,
  authorizeDiscordReservationInteraction,
  buildDiscordDeferredEphemeralResponse,
  buildDiscordImmediateEphemeralErrorResponse,
  buildDiscordPongResponse,
  buildDiscordRejectReasonModal,
  parseDiscordReservationInteraction
} from "./discord-interactions";

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
    data: { component_type: 2, custom_id: input.customId ?? "reservation:accept:reservation-1" },
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
      custom_id: input.customId ?? "reservation:reject:reservation-1"
    },
    type: 5
  };
}

describe("Discord reservation interaction contracts", () => {
  it("returns a PONG for a configured PING without requiring a ledger", () => {
    // Given: Discord's database-free PING payload from the configured application.
    const parsed = parseDiscordReservationInteraction({ application_id: config.applicationId, type: 1 });

    // When: its application binding is checked and the PING is converted into an immediate response.
    const authorization = authorizeDiscordPingInteraction({ config, interaction: parsed });
    const response = parsed.kind === "ping" ? buildDiscordPongResponse() : null;

    // Then: PING has no ledger dependency, rejects a wrong app, and returns PONG type 1.
    expect(authorization).toEqual({ kind: "authorized" });
    expect(authorizeDiscordPingInteraction({ config, interaction: parseDiscordReservationInteraction({ application_id: "999999999999999999", type: 1 }) })).toEqual({ code: "wrong_application", kind: "rejected" });
    expect(parseDiscordReservationInteraction({ type: 1 })).toEqual({ kind: "invalid" });
    expect(response).toEqual({ type: 1 });
  });

  it("parses exact accept and reject buttons and builds their response contracts", () => {
    // Given: one configured accept button and one configured reject button.
    const accept = parseDiscordReservationInteraction(componentInteraction());
    const reject = parseDiscordReservationInteraction(componentInteraction({ customId: "reservation:reject:reservation-1" }));

    // When: the actions are translated into Discord interaction responses.
    const acceptResponse = buildDiscordDeferredEphemeralResponse();
    const rejectResponse = buildDiscordRejectReasonModal("reservation-1");

    // Then: accept defers ephemerally while reject opens a reservation-bound modal.
    expect(accept).toMatchObject({ command: { kind: "accept", reservationId: "reservation-1" }, kind: "component" });
    expect(reject).toMatchObject({ command: { kind: "reject", reservationId: "reservation-1" }, kind: "component" });
    expect(acceptResponse).toEqual({ data: { flags: 64 }, type: 5 });
    expect(rejectResponse).toMatchObject({
      data: {
        components: [{ components: [{ custom_id: "reason", max_length: 200, min_length: 1, required: true, type: 4 }], type: 1 }],
        custom_id: "reservation:reject:reservation-1"
      },
      type: 9
    });
  });

  it("parses a reservation-bound reject modal and trims its required reason", () => {
    // Given: a modal submission with a padded but valid reason.
    const parsed = parseDiscordReservationInteraction(modalInteraction());

    // When: the payload crosses the parsing boundary.
    // Then: it produces a reject command with the trimmed reason.
    expect(parsed).toMatchObject({
      command: { kind: "reject", reason: "운영 사유", reservationId: "reservation-1" },
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
    const parsed = parseDiscordReservationInteraction(interaction);

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
    ["wrong reservation binding", componentInteraction({ customId: "reservation:accept:reservation-2" }), "wrong_reservation"],
    ["modal wrong source message", modalInteraction({ messageId: "999999999999999999" }), "wrong_source_message"]
  ] as const)("rejects authorization for %s", (_scenario, interaction, code) => {
    // Given: a parseable interaction that fails one authorization guard.
    const parsed = parseDiscordReservationInteraction(interaction);

    // When: the configured authorization and injected ledger snapshot are applied.
    const result = authorizeDiscordReservationInteraction({ config, interaction: parsed, ledger });

    // Then: no mutation command is produced.
    expect(result).toEqual({ code, kind: "rejected" });
  });

  it("authorizes a bound administrator and emits only the trusted command fields", () => {
    // Given: a parsed reject modal from the configured guild, channel, role, user, and source message.
    const parsed = parseDiscordReservationInteraction(modalInteraction({ reason: "행사 준비" }));

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
});
