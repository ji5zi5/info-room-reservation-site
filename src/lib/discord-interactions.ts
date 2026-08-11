import { z } from "zod";

import type { DiscordApplicationConfig } from "./discord-app-config";

const DISCORD_SNOWFLAKE = z.string().regex(/^\d{17,20}$/u);
const RESERVATION_ID = "[A-Za-z0-9_-]{1,191}";
const componentCustomIdSchema = z.string().regex(new RegExp(`^reservation:(accept|reject):(${RESERVATION_ID})$`, "u"));
const rejectModalCustomIdSchema = z.string().regex(new RegExp(`^reservation:reject:(${RESERVATION_ID})$`, "u"));
const rejectReasonSchema = z.string().trim().min(1).max(200);
const pingInteractionSchema = z.object({ application_id: DISCORD_SNOWFLAKE, type: z.literal(1) }).passthrough();

const interactionBaseSchema = z.object({
  application_id: DISCORD_SNOWFLAKE,
  channel_id: DISCORD_SNOWFLAKE,
  guild_id: DISCORD_SNOWFLAKE,
  id: DISCORD_SNOWFLAKE,
  member: z.object({
    roles: z.array(DISCORD_SNOWFLAKE),
    user: z.object({ id: DISCORD_SNOWFLAKE }).passthrough()
  }).passthrough(),
  message: z.object({ id: DISCORD_SNOWFLAKE }).passthrough(),
  token: z.string().min(1),
  type: z.union([z.literal(3), z.literal(5)])
}).passthrough();

const componentInteractionSchema = interactionBaseSchema.extend({
  data: z.object({ component_type: z.literal(2), custom_id: componentCustomIdSchema }).passthrough(),
  type: z.literal(3)
});

const modalInteractionSchema = interactionBaseSchema.extend({
  data: z.object({
    components: z.array(z.object({
      components: z.array(z.object({
        custom_id: z.string().min(1),
        type: z.literal(4),
        value: z.string()
      }).passthrough()).min(1),
      type: z.literal(1)
    }).passthrough()).min(1),
    custom_id: rejectModalCustomIdSchema
  }).passthrough(),
  type: z.literal(5)
});

export type DiscordReservationMessageLedgerSnapshot = {
  readonly messageId: string;
  readonly reservationId: string;
};

export type DiscordReservationInteractionCommand =
  | {
      readonly discordActorId: string;
      readonly interactionId: string;
      readonly interactionToken: string;
      readonly kind: "accept";
      readonly reservationId: string;
      readonly sourceMessageId: string;
      readonly studentNumber: string;
    }
  | {
      readonly discordActorId: string;
      readonly interactionId: string;
      readonly interactionToken: string;
      readonly kind: "open_reject_modal";
      readonly reservationId: string;
      readonly sourceMessageId: string;
      readonly studentNumber: string;
    }
  | {
      readonly discordActorId: string;
      readonly interactionId: string;
      readonly interactionToken: string;
      readonly kind: "reject";
      readonly reason: string;
      readonly reservationId: string;
      readonly sourceMessageId: string;
      readonly studentNumber: string;
    };

export type DiscordReservationInteraction =
  | { readonly kind: "invalid" }
  | { readonly applicationId: string; readonly kind: "ping" }
  | {
      readonly applicationId: string;
      readonly channelId: string;
      readonly command: { readonly kind: "accept" | "reject"; readonly reservationId: string };
      readonly discordUserId: string;
      readonly guildId: string;
      readonly interactionId: string;
      readonly interactionToken: string;
      readonly kind: "component";
      readonly messageId: string;
      readonly roleIds: readonly string[];
    }
  | {
      readonly applicationId: string;
      readonly channelId: string;
      readonly command: { readonly kind: "reject"; readonly reason: string; readonly reservationId: string };
      readonly discordUserId: string;
      readonly guildId: string;
      readonly interactionId: string;
      readonly interactionToken: string;
      readonly kind: "modal_submit";
      readonly messageId: string;
      readonly roleIds: readonly string[];
    };

export type DiscordReservationInteractionAuthorization =
  | { readonly command: DiscordReservationInteractionCommand; readonly kind: "authorized" }
  | {
      readonly code:
        | "invalid_interaction"
        | "missing_required_role"
        | "unmapped_discord_user"
        | "wrong_application"
        | "wrong_channel"
        | "wrong_guild"
        | "wrong_reservation"
        | "wrong_source_message";
      readonly kind: "rejected";
    };

export type DiscordPingInteractionAuthorization =
  | { readonly kind: "authorized" }
  | { readonly code: "invalid_interaction" | "wrong_application"; readonly kind: "rejected" };

export type DiscordInteractionResponse =
  | { readonly type: 1 }
  | { readonly data: { readonly flags: 64 }; readonly type: 5 }
  | { readonly data: { readonly content: string; readonly flags: 64 }; readonly type: 4 }
  | {
      readonly data: {
        readonly components: readonly [{ readonly components: readonly [{ readonly custom_id: "reason"; readonly label: string; readonly max_length: 200; readonly min_length: 1; readonly required: true; readonly style: 2; readonly type: 4 }]; readonly type: 1 }];
        readonly custom_id: string;
        readonly title: string;
      };
      readonly type: 9;
    };

export function parseDiscordReservationInteraction(input: unknown): DiscordReservationInteraction {
  const ping = pingInteractionSchema.safeParse(input);
  if (ping.success) return { applicationId: ping.data.application_id, kind: "ping" };

  const component = componentInteractionSchema.safeParse(input);
  if (component.success) {
    const command = parseComponentCommand(component.data.data.custom_id);
    return command === null
      ? { kind: "invalid" }
      : { ...actionFields(component.data), command, kind: "component" };
  }

  const modal = modalInteractionSchema.safeParse(input);
  if (!modal.success) return { kind: "invalid" };
  const reservationId = parseRejectModalReservationId(modal.data.data.custom_id);
  const reason = parseRejectReason(modal.data.data.components);
  return reservationId === null || reason === null
    ? { kind: "invalid" }
    : { ...actionFields(modal.data), command: { kind: "reject", reason, reservationId }, kind: "modal_submit" };
}

export function authorizeDiscordReservationInteraction(input: {
  readonly config: DiscordApplicationConfig;
  readonly interaction: DiscordReservationInteraction;
  readonly ledger: DiscordReservationMessageLedgerSnapshot;
}): DiscordReservationInteractionAuthorization {
  switch (input.interaction.kind) {
    case "component":
      return authorizeActionInteraction({ ...input, interaction: input.interaction });
    case "modal_submit":
      return authorizeActionInteraction({ ...input, interaction: input.interaction });
    case "invalid":
    case "ping":
      return { code: "invalid_interaction", kind: "rejected" };
    default:
      return assertNever(input.interaction);
  }
}

export function authorizeDiscordPingInteraction(input: {
  readonly config: DiscordApplicationConfig;
  readonly interaction: DiscordReservationInteraction;
}): DiscordPingInteractionAuthorization {
  switch (input.interaction.kind) {
    case "ping":
      return input.interaction.applicationId === input.config.applicationId
        ? { kind: "authorized" }
        : { code: "wrong_application", kind: "rejected" };
    case "component":
    case "invalid":
    case "modal_submit":
      return { code: "invalid_interaction", kind: "rejected" };
    default:
      return assertNever(input.interaction);
  }
}

export function buildDiscordPongResponse(): DiscordInteractionResponse {
  return { type: 1 };
}

export function buildDiscordRejectReasonModal(reservationId: string): DiscordInteractionResponse {
  return {
    data: {
      components: [{
        components: [{ custom_id: "reason", label: "거절 사유", max_length: 200, min_length: 1, required: true, style: 2, type: 4 }],
        type: 1
      }],
      custom_id: `reservation:reject:${reservationId}`,
      title: "예약 거절 사유"
    },
    type: 9
  };
}

export function buildDiscordDeferredEphemeralResponse(): DiscordInteractionResponse {
  return { data: { flags: 64 }, type: 5 };
}

export function buildDiscordImmediateEphemeralErrorResponse(): DiscordInteractionResponse {
  return { data: { content: "요청을 처리할 수 없습니다.", flags: 64 }, type: 4 };
}

function actionFields(interaction: z.infer<typeof interactionBaseSchema>) {
  return {
    applicationId: interaction.application_id,
    channelId: interaction.channel_id,
    discordUserId: interaction.member.user.id,
    guildId: interaction.guild_id,
    interactionId: interaction.id,
    interactionToken: interaction.token,
    messageId: interaction.message.id,
    roleIds: interaction.member.roles
  };
}

function authorizeActionInteraction(input: {
  readonly config: DiscordApplicationConfig;
  readonly interaction: Extract<DiscordReservationInteraction, { readonly kind: "component" | "modal_submit" }>;
  readonly ledger: DiscordReservationMessageLedgerSnapshot;
}): DiscordReservationInteractionAuthorization {
  const { config, interaction, ledger } = input;
  if (interaction.applicationId !== config.applicationId) return { code: "wrong_application", kind: "rejected" };
  if (interaction.guildId !== config.guildId) return { code: "wrong_guild", kind: "rejected" };
  if (interaction.channelId !== config.channelId) return { code: "wrong_channel", kind: "rejected" };
  if (interaction.messageId !== ledger.messageId) return { code: "wrong_source_message", kind: "rejected" };
  if (!interaction.roleIds.includes(config.adminRoleId)) return { code: "missing_required_role", kind: "rejected" };
  const binding = config.adminUserBindings.find(({ discordUserId }) => discordUserId === interaction.discordUserId);
  if (binding === undefined) return { code: "unmapped_discord_user", kind: "rejected" };
  if (interaction.command.reservationId !== ledger.reservationId) return { code: "wrong_reservation", kind: "rejected" };

  const base = {
    discordActorId: interaction.discordUserId,
    interactionId: interaction.interactionId,
    interactionToken: interaction.interactionToken,
    reservationId: ledger.reservationId,
    sourceMessageId: ledger.messageId,
    studentNumber: binding.studentNumber
  };
  switch (interaction.kind) {
    case "component":
      return {
        command: interaction.command.kind === "accept" ? { ...base, kind: "accept" } : { ...base, kind: "open_reject_modal" },
        kind: "authorized"
      };
    case "modal_submit":
      return { command: { ...base, kind: "reject", reason: interaction.command.reason }, kind: "authorized" };
    default:
      return assertNever(interaction);
  }
}

function parseComponentCommand(customId: string): { readonly kind: "accept" | "reject"; readonly reservationId: string } | null {
  const match = /^reservation:(accept|reject):([A-Za-z0-9_-]{1,191})$/u.exec(customId);
  return match === null || match[1] === undefined || match[2] === undefined
    ? null
    : { kind: match[1] === "accept" ? "accept" : "reject", reservationId: match[2] };
}

function parseRejectModalReservationId(customId: string): string | null {
  const match = /^reservation:reject:([A-Za-z0-9_-]{1,191})$/u.exec(customId);
  return match?.[1] ?? null;
}

function parseRejectReason(rows: readonly { readonly components: readonly { readonly custom_id: string; readonly type: number; readonly value: string }[] }[]): string | null {
  const reasons = rows.flatMap((row) => row.components.filter((component) => component.custom_id === "reason" && component.type === 4));
  if (reasons.length !== 1 || reasons[0] === undefined) return null;
  const parsed = rejectReasonSchema.safeParse(reasons[0].value);
  return parsed.success ? parsed.data : null;
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected Discord interaction: ${JSON.stringify(value)}`);
}
