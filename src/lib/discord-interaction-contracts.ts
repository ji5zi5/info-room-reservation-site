import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";


const DISCORD_SNOWFLAKE = z.string().regex(/^\d{17,20}$/u);
const CUSTOM_ID_MAX_LENGTH = 100;
const RESERVATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,191}$/u;
const customIdSchema = z.string().min(1).max(CUSTOM_ID_MAX_LENGTH);
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
  data: z.object({ component_type: z.literal(2), custom_id: customIdSchema }).passthrough(),
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
    custom_id: customIdSchema
  }).passthrough(),
  type: z.literal(5)
});

export type DiscordReservationMessageLedgerSnapshot = {
  readonly messageId: string;
  readonly reservationId: string;
};

export type DiscordReservationCustomIdAction = "accept" | "admin_cancel" | "no_show" | "reject";

export type DiscordReservationVerifiedCustomId = {
  readonly kind: DiscordReservationCustomIdAction;
  readonly renderedEpoch?: number;
  readonly reservationId: string;
  readonly sourceIdentity?: string;
};

type AuthorizedInteractionCommandBase = {
  readonly discordActorId: string;
  readonly interactionId: string;
  readonly interactionToken: string;
  readonly reservationId: string;
  readonly sourceMessageId: string;
  readonly studentNumber: string;
};

export type DiscordReservationInteractionCommand =
  | (AuthorizedInteractionCommandBase & { readonly kind: "accept" })
  | (AuthorizedInteractionCommandBase & { readonly kind: "open_reject_modal" })
  | (AuthorizedInteractionCommandBase & { readonly kind: "reject"; readonly reason: string });

export type DiscordReservationInteraction =
  | { readonly kind: "invalid" }
  | { readonly applicationId: string; readonly kind: "ping" }
  | {
      readonly applicationId: string;
      readonly channelId: string;
      readonly command: DiscordReservationVerifiedCustomId;
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
      readonly command: DiscordReservationVerifiedCustomId & { readonly kind: "admin_cancel" | "reject"; readonly reason: string };
      readonly discordUserId: string;
      readonly guildId: string;
      readonly interactionId: string;
      readonly interactionToken: string;
      readonly kind: "modal_submit";
      readonly messageId: string;
      readonly roleIds: readonly string[];
    };

export function parseDiscordReservationInteraction(
  input: unknown,
  secret: string = process.env.DISCORD_BOT_TOKEN ?? ""
): DiscordReservationInteraction {
  const ping = pingInteractionSchema.safeParse(input);
  if (ping.success) return { applicationId: ping.data.application_id, kind: "ping" };

  const component = componentInteractionSchema.safeParse(input);
  if (component.success) {
    const command = parseDiscordReservationCustomId(component.data.data.custom_id, secret);
    return command === null
      ? { kind: "invalid" }
      : { ...actionFields(component.data), command, kind: "component" };
  }

  const modal = modalInteractionSchema.safeParse(input);
  if (!modal.success) return { kind: "invalid" };
  const command = parseDiscordReservationCustomId(modal.data.data.custom_id, secret);
  const reason = parseRejectReason(modal.data.data.components);
  if (command === null || reason === null) return { kind: "invalid" };
  switch (command.kind) {
    case "admin_cancel":
    case "reject":
      return { ...actionFields(modal.data), command: { ...command, kind: command.kind, reason }, kind: "modal_submit" };
    case "accept":
    case "no_show":
      return { kind: "invalid" };
    default:
      return assertNever(command.kind);
  }
}

export function buildDiscordReservationCustomId(input: {
  readonly action: DiscordReservationCustomIdAction;
  readonly renderedEpoch: number;
  readonly reservationId: string;
  readonly secret: string;
  readonly sourceIdentity?: string;
}): string {
  if (!RESERVATION_ID_PATTERN.test(input.reservationId) || !Number.isSafeInteger(input.renderedEpoch) || input.renderedEpoch < 0 || input.secret.length === 0) {
    throw new InvalidDiscordReservationCustomIdError();
  }
  const action = customIdActionCode(input.action);
  const identity = Buffer.from(input.reservationId, "utf8").toString("base64url");
  const sourceIdentity = input.sourceIdentity ?? defaultSourceIdentity(input.reservationId);
  if (!RESERVATION_ID_PATTERN.test(sourceIdentity)) throw new InvalidDiscordReservationCustomIdError();
  const source = Buffer.from(sourceIdentity, "utf8").toString("base64url");
  const body = `dr2.${action}.${input.renderedEpoch.toString(36)}.${identity}.${source}`;
  const customId = `${body}.${customIdMac(body, input.secret)}`;
  if (customId.length > CUSTOM_ID_MAX_LENGTH) throw new InvalidDiscordReservationCustomIdError();
  return customId;
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

function parseDiscordReservationCustomId(customId: string, secret: string): DiscordReservationVerifiedCustomId | null {
  if (secret.length === 0 || customId.length > CUSTOM_ID_MAX_LENGTH) return null;
  const [version, actionCode, epochText, identity, source, mac, extra] = customId.split(".");
  if (version !== "dr2" || actionCode === undefined || epochText === undefined || identity === undefined || source === undefined || mac === undefined || extra !== undefined || !/^[0-9a-z]+$/u.test(epochText)) return null;
  const kind = customIdAction(actionCode);
  const renderedEpoch = Number.parseInt(epochText, 36);
  const reservationId = Buffer.from(identity, "base64url").toString("utf8");
  const sourceIdentity = Buffer.from(source, "base64url").toString("utf8");
  const body = `${version}.${actionCode}.${epochText}.${identity}.${source}`;
  const expected = customIdMac(body, secret);
  if (kind === null || !Number.isSafeInteger(renderedEpoch) || renderedEpoch < 0 || !RESERVATION_ID_PATTERN.test(reservationId) || !RESERVATION_ID_PATTERN.test(sourceIdentity) || Buffer.from(reservationId, "utf8").toString("base64url") !== identity || Buffer.from(sourceIdentity, "utf8").toString("base64url") !== source || !secureEqual(mac, expected)) return null;
  return { kind, renderedEpoch, reservationId, sourceIdentity };
}

function defaultSourceIdentity(reservationId: string): string {
  return `reservation-${createHash("sha256").update(reservationId).digest("hex").slice(0, 12)}`;
}

function parseRejectReason(rows: readonly { readonly components: readonly { readonly custom_id: string; readonly type: number; readonly value: string }[] }[]): string | null {
  const reasons = rows.flatMap((row) => row.components.filter((component) => component.custom_id === "reason" && component.type === 4));
  if (reasons.length !== 1 || reasons[0] === undefined) return null;
  const parsed = rejectReasonSchema.safeParse(reasons[0].value);
  return parsed.success ? parsed.data : null;
}

function customIdMac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(`discord-reservation-control:v2\0${body}`).digest("base64url").slice(0, 22);
}

function secureEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function customIdActionCode(action: DiscordReservationCustomIdAction): string {
  switch (action) {
    case "accept": return "a";
    case "reject": return "r";
    case "admin_cancel": return "c";
    case "no_show": return "n";
    default: return assertNever(action);
  }
}

function customIdAction(code: string): DiscordReservationCustomIdAction | null {
  switch (code) {
    case "a": return "accept";
    case "r": return "reject";
    case "c": return "admin_cancel";
    case "n": return "no_show";
    default: return null;
  }
}

function assertNever(value: never): never {
  throw new InvalidDiscordReservationCustomIdError(String(value));
}

class InvalidDiscordReservationCustomIdError extends Error {
  public constructor(value: string = "invalid") {
    super(`Invalid Discord reservation custom ID: ${value}`);
    this.name = "InvalidDiscordReservationCustomIdError";
  }
}
