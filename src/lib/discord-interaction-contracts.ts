import { z } from "zod";

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
