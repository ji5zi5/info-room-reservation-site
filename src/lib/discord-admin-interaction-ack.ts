import type { DiscordApplicationConfig } from "./discord-app-config";
import { authorizeDiscordAdminSource, type DiscordAuthorizedAdmin } from "./discord-admin-authorization";
import type { DiscordAdminInteraction } from "./discord-admin-interaction-contracts";
import {
  buildDiscordAdminReasonModal,
  type DiscordAdminInteractionResponse
} from "./discord-admin-interaction-responses";
import {
  isDiscordAdminReadIntent,
  isDiscordAdminReasonDraft,
  type DiscordAdminReadIntent
} from "./discord-admin-intents";
import { isCurrentDiscordOperationsBoardControl } from "./prisma-discord-operations-board";
import {
  activateDiscordAdminCommandJob,
  attachDiscordAdminCommandReason,
  stageDiscordAdminCommand,
  stageDiscordAdminReasonDraft
} from "./prisma-discord-admin-command-job-store";

const ACK_DEADLINE_MS = 1_500;

type ValidInteraction = Exclude<DiscordAdminInteraction, { readonly kind: "invalid" }>;

export type PreparedDiscordAdminInteraction =
  | { readonly kind: "rejected" }
  | { readonly kind: "modal"; readonly response: DiscordAdminInteractionResponse }
  | {
      readonly actor: DiscordAuthorizedAdmin;
      readonly interactionId: string;
      readonly interactionToken: string;
      readonly intent: DiscordAdminReadIntent;
      readonly kind: "read";
    }
  | {
      readonly executionInteractionId: string;
      readonly interactionToken: string;
      readonly kind: "job";
    }
  | {
      readonly action: Extract<ValidInteraction, { readonly kind: "board_component" }>['action'];
      readonly actor: DiscordAuthorizedAdmin;
      readonly interactionId: string;
      readonly interactionToken: string;
      readonly kind: "board";
    };

export async function prepareDiscordAdminInteraction(input: {
  readonly config: DiscordApplicationConfig;
  readonly interaction: ValidInteraction;
  readonly ipHash: string;
  readonly now: Date;
}): Promise<PreparedDiscordAdminInteraction> {
  const authorization = await authorizeDiscordAdminSource({ config: input.config, interaction: input.interaction });
  if (authorization.kind !== "authorized") return { kind: "rejected" };
  switch (input.interaction.kind) {
    case "command":
      return prepareCommand({ ...input, actor: authorization.actor, interaction: input.interaction });
    case "reason_submit":
      return prepareReasonSubmit({ ...input, actor: authorization.actor, interaction: input.interaction });
    case "board_component": {
      const current = await isCurrentDiscordOperationsBoardControl({
        channelId: input.interaction.channelId,
        guildId: input.interaction.guildId,
        messageId: input.interaction.messageId,
        revision: input.interaction.revision
      });
      return current
        ? {
            action: input.interaction.action,
            actor: authorization.actor,
            interactionId: input.interaction.interactionId,
            interactionToken: input.interaction.interactionToken,
            kind: "board"
          }
        : { kind: "rejected" };
    }
    default:
      return assertNever(input.interaction);
  }
}

async function prepareCommand(input: {
  readonly actor: DiscordAuthorizedAdmin;
  readonly config: DiscordApplicationConfig;
  readonly interaction: Extract<ValidInteraction, { readonly kind: "command" }>;
  readonly ipHash: string;
  readonly now: Date;
}): Promise<PreparedDiscordAdminInteraction> {
  if (isDiscordAdminReadIntent(input.interaction.intent)) {
    return {
      actor: input.actor,
      interactionId: input.interaction.interactionId,
      interactionToken: input.interaction.interactionToken,
      intent: input.interaction.intent,
      kind: "read"
    };
  }
  const common = stageContext(input);
  if (isDiscordAdminReasonDraft(input.interaction.intent)) {
    const staged = await stageDiscordAdminReasonDraft({ ...common, now: input.now });
    return staged.kind === "staged" || staged.kind === "duplicate"
      ? {
          kind: "modal",
          response: buildDiscordAdminReasonModal({
            intent: input.interaction.intent,
            secret: input.config.botToken,
            sourceInteractionId: input.interaction.interactionId
          })
        }
      : { kind: "rejected" };
  }
  const activationDeadline = new Date(input.now.getTime() + ACK_DEADLINE_MS);
  const staged = await stageDiscordAdminCommand({
    ...common,
    activationDeadline,
    executionInteractionId: input.interaction.interactionId
  });
  return activate(staged, input.interaction.interactionId, input.interaction.interactionToken);
}

async function prepareReasonSubmit(input: {
  readonly actor: DiscordAuthorizedAdmin;
  readonly config: DiscordApplicationConfig;
  readonly interaction: Extract<ValidInteraction, { readonly kind: "reason_submit" }>;
  readonly ipHash: string;
  readonly now: Date;
}): Promise<PreparedDiscordAdminInteraction> {
  const staged = await attachDiscordAdminCommandReason({
    activationDeadline: new Date(input.now.getTime() + ACK_DEADLINE_MS),
    discordActorId: input.interaction.discordUserId,
    executionInteractionId: input.interaction.interactionId,
    localActorId: input.actor.id,
    reason: input.interaction.reason,
    sourceApplicationId: input.interaction.applicationId,
    sourceChannelId: input.interaction.channelId,
    sourceGuildId: input.interaction.guildId,
    sourceInteractionId: input.interaction.sourceInteractionId
  });
  return activate(staged, input.interaction.interactionId, input.interaction.interactionToken);
}

async function activate(
  staged: Awaited<ReturnType<typeof stageDiscordAdminCommand>>,
  executionInteractionId: string,
  interactionToken: string
): Promise<PreparedDiscordAdminInteraction> {
  if (staged.kind !== "staged" && staged.kind !== "duplicate") return { kind: "rejected" };
  const activation = await activateDiscordAdminCommandJob({ commandDigest: staged.commandDigest, executionInteractionId });
  return activation.kind === "acknowledged"
    ? { executionInteractionId, interactionToken, kind: "job" }
    : { kind: "rejected" };
}

function stageContext(input: {
  readonly actor: DiscordAuthorizedAdmin;
  readonly interaction: Extract<ValidInteraction, { readonly kind: "command" }>;
  readonly ipHash: string;
}) {
  return {
    discordActorId: input.interaction.discordUserId,
    draftIntent: JSON.stringify(input.interaction.intent),
    ipHash: input.ipHash,
    localActorId: input.actor.id,
    sourceApplicationId: input.interaction.applicationId,
    sourceChannelId: input.interaction.channelId,
    sourceGuildId: input.interaction.guildId,
    sourceInteractionId: input.interaction.interactionId
  };
}

function assertNever(value: never): never {
  throw new DiscordAdminInteractionVariantError(JSON.stringify(value));
}

class DiscordAdminInteractionVariantError extends Error {
  public override readonly name = "DiscordAdminInteractionVariantError";
}
