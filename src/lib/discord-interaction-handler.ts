import { createHash } from "node:crypto";

import { z } from "zod";

import type { DiscordApplicationConfig } from "./discord-app-config";
import { createDiscordBotClient, type DiscordBotDeliveryResult, type DiscordBotMessagePayload } from "./discord-bot";
import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";
import {
  runDiscordInteractionJobs,
  type DiscordInteractionDispatchResult,
  type DiscordInteractionJobClaim,
  type DiscordInteractionJobRunResult
} from "./discord-interaction-job-runner";
import {
  adaptDiscordReservationOperationCommand,
  type DiscordReservationInteraction
} from "./discord-interactions";
import { dispatchDiscordReservationOperation } from "./discord-reservation-outbox-runtime";
import type { DiscordReservationOperationCommand } from "./discord-reservation-operations";
import {
  activateDiscordInteractionJob,
  prismaDiscordInteractionJobStore,
  settleDiscordInteractionHandshake,
  stageDiscordInteractionJob,
  type DiscordInteractionActivationResult,
  type DiscordInteractionEnqueueResult,
  type DiscordInteractionSettlementResult,
  type DiscordInteractionStageInput
} from "./prisma-discord-interaction-job-store";

const ACK_DEADLINE_MS = 1_500;
const HANDSHAKE_TRANSACTION_OPTIONS = { maxWait: 100, timeout: 800 } as const;
const persistedIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accept"), studentNumber: z.string().min(1) }),
  z.object({ kind: z.literal("admin_cancel"), reason: z.string().min(1).max(200), studentNumber: z.string().min(1) }),
  z.object({ kind: z.literal("no_show"), studentNumber: z.string().min(1) }),
  z.object({ kind: z.literal("reject"), reason: z.string().min(1).max(200), studentNumber: z.string().min(1) })
]);

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

type HandlerDependencies = {
  readonly activate: (input: { readonly commandDigest: string; readonly interactionId: string }) => Promise<DiscordInteractionActivationResult>;
  readonly clockMs: () => number;
  readonly dispatch: (input: { readonly command: DiscordReservationOperationCommand; readonly ipHash: string; readonly now: Date }) => Promise<DiscordInteractionDispatchResult>;
  readonly editCompletion: (input: {
    readonly applicationId: string;
    readonly botToken: string;
    readonly interactionToken: string;
    readonly payload: DiscordBotMessagePayload;
  }) => Promise<DiscordBotDeliveryResult>;
  readonly loadContext: (input: { readonly messageId: string; readonly studentNumber: string }) => Promise<AuthorizedContext | null>;
  readonly runJobs: (input: {
    readonly dispatch: (claim: DiscordInteractionJobClaim) => Promise<DiscordInteractionDispatchResult>;
    readonly interactionId?: string;
    readonly now: Date;
    readonly store: typeof prismaDiscordInteractionJobStore;
  }) => Promise<DiscordInteractionJobRunResult>;
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
    }): Promise<void> => runExact(dependencies, input)
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
  waitForDeadline
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
      const staged = stageInput(resolved.command, input.ipHash, new Date(
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

function stageInput(
  command: DiscordReservationOperationCommand,
  ipHash: string,
  activationDeadline: Date
): DiscordInteractionStageInput {
  const intent = serializeIntent(command);
  const durable = {
    commandDigest: "",
    discordActorId: command.discordActorId,
    interactionId: command.interactionId,
    intent,
    ipHash,
    localActorId: command.localActorId,
    renderedEpoch: command.renderedControlEpoch,
    reservationId: command.reservationId,
    sourceApplicationId: command.sourceApplicationId ?? "",
    sourceChannelId: command.sourceChannelId,
    sourceGuildId: command.sourceGuildId,
    sourceMessageId: command.sourceMessageId
  };
  return {
    ...durable,
    activationDeadline,
    commandDigest: commandDigest(durable)
  };
}

function serializeIntent(command: DiscordReservationOperationCommand): string {
  switch (command.kind) {
    case "accept": return JSON.stringify({ kind: command.kind, studentNumber: command.studentNumber });
    case "admin_cancel":
    case "reject": return JSON.stringify({ kind: command.kind, reason: command.reason, studentNumber: command.studentNumber });
    case "no_show": return JSON.stringify({ kind: command.kind, studentNumber: command.studentNumber });
    default: return assertNever(command);
  }
}

function commandDigest(input: Omit<DiscordInteractionStageInput, "activationDeadline" | "commandDigest"> & { readonly commandDigest: string }): string {
  const canonical = JSON.stringify({
    discordActorId: input.discordActorId,
    interactionId: input.interactionId,
    intent: input.intent,
    localActorId: input.localActorId,
    renderedEpoch: input.renderedEpoch,
    reservationId: input.reservationId,
    sourceApplicationId: input.sourceApplicationId,
    sourceChannelId: input.sourceChannelId,
    sourceGuildId: input.sourceGuildId,
    sourceMessageId: input.sourceMessageId
  });
  return `sha256:${createHash("sha256").update("discord-interaction-job:v1\0").update(canonical).digest("hex")}`;
}

async function runExact(
  dependencies: HandlerDependencies,
  input: { readonly applicationId: string; readonly botToken: string; readonly interactionId: string; readonly interactionToken: string }
): Promise<void> {
  let completion: DiscordInteractionDispatchResult | null = null;
  const result = await dependencies.runJobs({
    dispatch: async (claim) => {
      const operation = operationFromClaim(claim);
      const outcome = operation === null
        ? { errorCode: "persisted_command_invalid", errorType: "INTEGRITY", kind: "terminal_failure" } as const
        : await dependencies.dispatch({ command: operation, ipHash: claim.ipHash, now: new Date() });
      completion = outcome;
      return outcome;
    },
    interactionId: input.interactionId,
    now: new Date(),
    store: prismaDiscordInteractionJobStore
  });
  if (result.claimed !== 1) return;
  await editCompletionBestEffort(dependencies, input, completionPayload(completion));
}

function operationFromClaim(claim: DiscordInteractionJobClaim): DiscordReservationOperationCommand | null {
  const parsedJson = parsePersistedJson(claim.intent);
  const parsed = persistedIntentSchema.safeParse(parsedJson);
  if (!parsed.success) return null;
  const base = {
    discordActorId: claim.discordActorId,
    interactionId: claim.interactionId,
    localActorId: claim.localActorId,
    renderedControlEpoch: claim.renderedEpoch,
    reservationId: claim.reservationId,
    sourceApplicationId: claim.sourceApplicationId,
    sourceChannelId: claim.sourceChannelId,
    sourceGuildId: claim.sourceGuildId,
    sourceMessageId: claim.sourceMessageId,
    studentNumber: parsed.data.studentNumber
  };
  const digestInput = {
    commandDigest: "",
    discordActorId: claim.discordActorId,
    interactionId: claim.interactionId,
    intent: claim.intent,
    ipHash: claim.ipHash,
    localActorId: claim.localActorId,
    renderedEpoch: claim.renderedEpoch,
    reservationId: claim.reservationId,
    sourceApplicationId: claim.sourceApplicationId ?? "",
    sourceChannelId: claim.sourceChannelId,
    sourceGuildId: claim.sourceGuildId,
    sourceMessageId: claim.sourceMessageId
  };
  if (commandDigest(digestInput) !== claim.commandDigest) return null;
  switch (parsed.data.kind) {
    case "accept": return { ...base, kind: "accept" };
    case "admin_cancel": return { ...base, kind: "admin_cancel", reason: parsed.data.reason };
    case "no_show": return { ...base, kind: "no_show" };
    case "reject": return { ...base, kind: "reject", reason: parsed.data.reason };
    default: return assertNever(parsed.data);
  }
}

function parsePersistedJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
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

function completionPayload(result: DiscordInteractionDispatchResult | null): DiscordBotMessagePayload {
  if (result?.kind === "succeeded") return embedPayload(0x57f287, "처리 완료", "요청을 처리했습니다.");
  if (result?.kind === "stale") return embedPayload(0xfee75c, "처리 결과", "이미 처리되었거나 만료된 요청입니다.");
  return embedPayload(0xed4245, "처리 실패", "요청을 처리할 수 없습니다.");
}

async function editCompletionBestEffort(
  dependencies: HandlerDependencies,
  input: { readonly applicationId: string; readonly botToken: string; readonly interactionId: string; readonly interactionToken: string },
  payload: DiscordBotMessagePayload
): Promise<void> {
  try {
    const result = await dependencies.editCompletion({
      applicationId: input.applicationId,
      botToken: input.botToken,
      interactionToken: input.interactionToken,
      payload
    });
    if (result.kind !== "sent") reportDeliveryFailure(input.interactionId, result);
  } catch (error) {
    reportBoundaryFailure("discord_interaction_ephemeral_completion_failed", input.interactionId, error);
  }
}

function embedPayload(color: number, title: string, description: string): DiscordBotMessagePayload {
  return { allowed_mentions: { parse: [] }, embeds: [{ color, description, fields: [], title }] };
}

function waitForDeadline(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return; }
    const timer = setTimeout(() => resolve(true), milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(false); }, { once: true });
  });
}

function reportDeliveryFailure(interactionId: string, result: Exclude<DiscordBotDeliveryResult, { readonly kind: "sent" }>): void {
  console.error(JSON.stringify({ code: result.code, event: "discord_interaction_ephemeral_completion_failed", interactionId, outcome: result.outcome }));
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
