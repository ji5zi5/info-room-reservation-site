import type { DiscordApplicationConfig } from "./discord-app-config";
import type { DiscordGuildMemberLookupResult } from "./discord-bot";
import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";
import type {
  DiscordReservationInteraction,
  DiscordReservationInteractionCommand,
  DiscordReservationMessageLedgerSnapshot
} from "./discord-interaction-contracts";

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

export type CurrentDiscordReservationActorAuthorization =
  | { readonly kind: "authorized"; readonly studentNumber: string }
  | {
      readonly code: "guild_member_missing" | "missing_required_role" | "unmapped_discord_user";
      readonly kind: "stale";
    }
  | { readonly code: string; readonly kind: "retryable_failure" | "terminal_failure" };

export function authorizeCurrentDiscordReservationActor(input: {
  readonly config: DiscordApplicationConfig;
  readonly member: DiscordGuildMemberLookupResult;
  readonly source: {
    readonly discordActorId: string;
    readonly localActorId: string;
    readonly sourceChannelId: string;
    readonly sourceGuildId: string;
  };
}): CurrentDiscordReservationActorAuthorization {
  if (
    input.source.sourceGuildId !== input.config.guildId ||
    input.source.sourceChannelId !== input.config.channelId
  ) {
    return { code: "discord_config_mismatch", kind: "terminal_failure" };
  }
  switch (input.member.kind) {
    case "missing":
      return { code: "guild_member_missing", kind: "stale" };
    case "retryable_failure":
    case "terminal_failure":
      return input.member;
    case "found": {
      const binding = input.config.adminUserBindings.find(
        ({ discordUserId }) => discordUserId === input.source.discordActorId
      );
      if (binding === undefined) return { code: "unmapped_discord_user", kind: "stale" };
      return input.member.roleIds.includes(input.config.adminRoleId)
        ? { kind: "authorized", studentNumber: binding.studentNumber }
        : { code: "missing_required_role", kind: "stale" };
    }
    default:
      return assertNever(input.member);
  }
}

export async function resolveLegacyDiscordDecisionContext(input: {
  readonly reservationId: string;
  readonly studentNumber: string;
}): Promise<
  | { readonly code: "actor_not_found" | "stale_message"; readonly kind: "rejected" }
  | {
      readonly channelId: string;
      readonly guildId: string;
      readonly kind: "resolved";
      readonly localActorId: string;
      readonly renderedControlEpoch: number;
    }
> {
  const resolved = await withDatabaseContext({
    actor: systemDatabaseActor(),
    client: prisma,
    operation: async (transaction) => {
      const [actor, message] = await Promise.all([
        transaction.user.findUnique({ select: { id: true }, where: { studentNumber: input.studentNumber } }),
        transaction.discordReservationMessage.findUnique({
          select: { channelId: true, guildId: true, renderedSourceEpoch: true },
          where: { reservationId: input.reservationId }
        })
      ]);
      return { actor, message };
    }
  });
  if (resolved.actor === null) return { code: "actor_not_found", kind: "rejected" };
  if (resolved.message?.channelId == null || resolved.message.guildId === null) {
    return { code: "stale_message", kind: "rejected" };
  }
  return {
    channelId: resolved.message.channelId,
    guildId: resolved.message.guildId,
    kind: "resolved",
    localActorId: resolved.actor.id,
    renderedControlEpoch: resolved.message.renderedSourceEpoch
  };
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

function assertNever(value: never): never {
  throw new TypeError(`Unexpected Discord interaction: ${JSON.stringify(value)}`);
}
