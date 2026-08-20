import type { DiscordApplicationConfig } from "./discord-app-config";
import { createDiscordBotClient } from "./discord-bot";
import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";
import {
  runDiscordInteractionJobs,
} from "./discord-interaction-job-runner";
import { waitForDiscordInteractionDeadline } from "./discord-interaction-deadline";
import {
  buildDiscordInteractionStageInput,
} from "./discord-interaction-job-contract";
import {
  adaptDiscordReservationOperationCommand,
  type DiscordReservationInteraction
} from "./discord-interactions";
import { dispatchDiscordReservationOperation } from "./discord-reservation-outbox-runtime";
import type { DiscordReservationOperationCommand } from "./discord-reservation-operations";
import {
  runExactDiscordReservationInteraction,
  type DiscordInteractionCompletionDependencies
} from "./discord-reservation-interaction-completion";
import {
  activateDiscordInteractionJob,
  settleDiscordInteractionHandshake,
  stageDiscordInteractionJob,
  type DiscordInteractionActivationResult,
  type DiscordInteractionEnqueueResult,
  type DiscordInteractionSettlementResult,
  type DiscordInteractionStageInput
} from "./prisma-discord-interaction-job-store";

const ACK_DEADLINE_MS = 1_500;
const HANDSHAKE_TRANSACTION_OPTIONS = { maxWait: 100, timeout: 800 } as const;
type ActionInteraction = Extract<DiscordReservationInteraction, { readonly kind: "component" | "modal_submit" }>;

type AuthorizedContext = {
  readonly channelId: string;
  readonly guildId: string;
  readonly localActorId: string;
  readonly messageId: string;
  readonly nonce: string;
  readonly renderedEpoch: number;
  readonly reservationId: string;
  readonly studentNumber: string;
  readonly databaseNow: Date;
};

type HandlerDependencies = DiscordInteractionCompletionDependencies & {
  readonly activate: (input: { readonly commandDigest: string; readonly interactionId: string }) => Promise<DiscordInteractionActivationResult>;
  readonly clockMs: () => number;
  readonly loadContext: (input: { readonly messageId: string; readonly studentNumber: string }) => Promise<AuthorizedContext | null>;
  readonly stage: (input: DiscordInteractionStageInput) => Promise<DiscordInteractionEnqueueResult>;
  readonly settle: (input: { readonly commandDigest: string; readonly interactionId: string }) => Promise<DiscordInteractionSettlementResult>;
  readonly waitForDeadline: (milliseconds: number, signal: AbortSignal) => Promise<boolean>;
};

export type DiscordInteractionAcknowledgement = { readonly kind: "acknowledged" } | { readonly kind: "rejected" };
export type DiscordInteractionModalAuthorization = { readonly kind: "authorized" } | { readonly kind: "rejected" };

export function createDiscordInteractionHandler(dependencies: HandlerDependencies) {
  return {
    acknowledge: (input: {
      readonly config: DiscordApplicationConfig;
      readonly interaction: ActionInteraction;
      readonly ipHash: string;
    }): Promise<DiscordInteractionAcknowledgement> => acknowledge(dependencies, input),
    authorizeModal: async (input: {
      readonly config: DiscordApplicationConfig;
      readonly interaction: Extract<ActionInteraction, { readonly kind: "component" }>;
    }): Promise<DiscordInteractionModalAuthorization> => {
      if (input.interaction.command.kind === "accept") return { kind: "rejected" };
      return (await loadAuthorizedInteractionContext(dependencies, input)) === null
        ? { kind: "rejected" }
        : { kind: "authorized" };
    },
    runExact: (input: {
      readonly applicationId: string;
      readonly botToken: string;
      readonly interactionId: string;
      readonly interactionToken: string;
    }): Promise<void> => runExactDiscordReservationInteraction(dependencies, input)
  } as const;
}

const defaultHandler = createDiscordInteractionHandler({
  activate: activateDiscordInteractionJob,
  clockMs: () => performance.now(),
  dispatch: dispatchDiscordReservationOperation,
  editCompletion: async ({ applicationId, botToken, interactionToken, payload }) =>
    createDiscordBotClient({ applicationId, botToken }).editOriginalEphemeralResponse({ interactionToken, payload }),
  loadContext: loadAuthorizedContext,
  runJobs: runDiscordInteractionJobs,
  stage: stageDiscordInteractionJob,
  settle: settleDiscordInteractionHandshake,
  waitForDeadline: waitForDiscordInteractionDeadline
});

export const acknowledgeDiscordReservationInteraction = defaultHandler.acknowledge;
export const authorizeDiscordInteractionModal = defaultHandler.authorizeModal;
export const runExactPendingDiscordInteraction = defaultHandler.runExact;

async function acknowledge(
  dependencies: HandlerDependencies,
  input: { readonly config: DiscordApplicationConfig; readonly interaction: ActionInteraction; readonly ipHash: string }
): Promise<DiscordInteractionAcknowledgement> {
  const startedAt = dependencies.clockMs();
  const abortController = new AbortController();
  let timedOut = false;
  let stagedIdentity: { readonly commandDigest: string; readonly interactionId: string } | null = null;
  let settlement: Promise<DiscordInteractionAcknowledgement> | null = null;

  const settle = (): Promise<DiscordInteractionAcknowledgement> => {
    const identity = stagedIdentity;
    if (identity === null) return Promise.resolve({ kind: "rejected" });
    settlement ??= dependencies.settle(identity).then((result) =>
      result.kind === "pending" ? { kind: "acknowledged" } : { kind: "rejected" }
    );
    return settlement;
  };

  const pipeline = async (): Promise<DiscordInteractionAcknowledgement> => {
    try {
      const resolved = await resolveCommand(dependencies, input);
      const remainingBeforeStage = ACK_DEADLINE_MS - (dependencies.clockMs() - startedAt);
      if (resolved === null || timedOut || remainingBeforeStage <= 0) return { kind: "rejected" };
      const staged = buildDiscordInteractionStageInput(resolved.command, input.ipHash, new Date(
        resolved.databaseNow.getTime() + remainingBeforeStage
      ));
      stagedIdentity = { commandDigest: staged.commandDigest, interactionId: staged.interactionId };
      const result = await dependencies.stage(staged);
      if (result.kind === "security_conflict") return { kind: "rejected" };
      if (timedOut) return settle();
      const activation = await dependencies.activate(stagedIdentity);
      return activation.kind === "pending" ? { kind: "acknowledged" } : settle();
    } catch (error) {
      reportBoundaryFailure("discord_interaction_ack_failed", input.interaction.interactionId, error);
      return stagedIdentity === null ? { kind: "rejected" } : settle();
    }
  };

  const deadline = async (): Promise<DiscordInteractionAcknowledgement> => {
    const elapsed = await dependencies.waitForDeadline(ACK_DEADLINE_MS, abortController.signal);
    if (!elapsed) return { kind: "rejected" };
    timedOut = true;
    return settle();
  };

  const result = await Promise.race([pipeline(), deadline()]);
  abortController.abort();
  return result;
}

async function resolveCommand(
  dependencies: HandlerDependencies,
  input: { readonly config: DiscordApplicationConfig; readonly interaction: ActionInteraction }
): Promise<{ readonly command: DiscordReservationOperationCommand; readonly databaseNow: Date } | null> {
  const context = await loadAuthorizedInteractionContext(dependencies, input);
  if (context === null) return null;
  const { interaction } = input;
  const command = adaptDiscordReservationOperationCommand({
    command: interaction.command,
    discordActorId: interaction.discordUserId,
    expectedSourceIdentity: context.nonce,
    interactionId: interaction.interactionId,
    localActorId: context.localActorId,
    sourceApplicationId: interaction.applicationId,
    sourceChannelId: interaction.channelId,
    sourceGuildId: interaction.guildId,
    sourceMessageId: interaction.messageId,
    studentNumber: context.studentNumber
  });
  if (command === null) return null;
  return {
    command,
    databaseNow: context.databaseNow
  };
}

async function loadAuthorizedInteractionContext(
  dependencies: HandlerDependencies,
  input: { readonly config: DiscordApplicationConfig; readonly interaction: ActionInteraction }
): Promise<AuthorizedContext | null> {
  const { config, interaction } = input;
  if (
    interaction.applicationId !== config.applicationId || interaction.guildId !== config.guildId ||
    interaction.channelId !== config.channelId || !interaction.roleIds.includes(config.adminRoleId)
  ) return null;
  const binding = config.adminUserBindings.find(({ discordUserId }) => discordUserId === interaction.discordUserId);
  if (binding === undefined) return null;
  const context = await dependencies.loadContext({ messageId: interaction.messageId, studentNumber: binding.studentNumber });
  if (
    context === null || context.channelId !== interaction.channelId || context.guildId !== interaction.guildId ||
    context.messageId !== interaction.messageId || context.studentNumber !== binding.studentNumber ||
    context.reservationId !== interaction.command.reservationId || context.nonce !== interaction.command.sourceIdentity ||
    context.renderedEpoch !== interaction.command.renderedEpoch
  ) return null;
  return context;
}

async function loadAuthorizedContext(input: {
  readonly messageId: string;
  readonly studentNumber: string;
}): Promise<AuthorizedContext | null> {
  return withDatabaseContext({
    actor: systemDatabaseActor(),
    client: prisma,
    operation: async (transaction) => {
      const [message, actor, clock] = await Promise.all([
        transaction.discordReservationMessage.findUnique({
          select: { channelId: true, guildId: true, messageId: true, nonce: true, renderedSourceEpoch: true, reservationId: true },
          where: { messageId: input.messageId }
        }),
        transaction.user.findUnique({ select: { id: true, role: true, studentNumber: true }, where: { studentNumber: input.studentNumber } }),
        transaction.$queryRaw<readonly { readonly now: Date }[]>`SELECT CURRENT_TIMESTAMP AS "now"`
      ]);
      if (
        message?.channelId == null || message.guildId === null || message.messageId === null ||
        actor === null || actor.role !== "ADMIN" || !(clock[0]?.now instanceof Date)
      ) return null;
      return {
        channelId: message.channelId,
        guildId: message.guildId,
        localActorId: actor.id,
        messageId: message.messageId,
        nonce: message.nonce,
        renderedEpoch: message.renderedSourceEpoch,
        reservationId: message.reservationId,
        databaseNow: clock[0].now,
        studentNumber: actor.studentNumber
      };
    },
    options: HANDSHAKE_TRANSACTION_OPTIONS
  });
}

function reportBoundaryFailure(event: string, interactionId: string, error: unknown): void {
  console.error(JSON.stringify({ errorType: error instanceof Error ? error.name : "UnknownError", event, interactionId }));
}

function assertNever(value: never): never {
  throw new DiscordInteractionVariantError(String(value));
}

class DiscordInteractionVariantError extends Error {
  public constructor(value: string) {
    super(`Unhandled Discord interaction variant: ${value}`);
    this.name = "DiscordInteractionVariantError";
  }
}
