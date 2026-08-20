import { Prisma } from "@prisma/client";

import { buildDiscordAdminCommandDigest, type DiscordAdminCommandIdentity } from "./discord-admin-command-digest";
import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";

const DRAFT_RETENTION_MS = 15 * 60_000;
const JOB_RETENTION_MS = 30 * 24 * 60 * 60_000;

export type DiscordAdminCommandStageInput = Omit<DiscordAdminCommandIdentity, "executionInteractionId" | "reason"> & {
  readonly activationDeadline: Date;
  readonly executionInteractionId: string;
};

export type DiscordAdminReasonDraftInput = Omit<DiscordAdminCommandIdentity, "executionInteractionId" | "reason"> & {
  readonly now: Date;
};

export type DiscordAdminReasonActivationInput = {
  readonly activationDeadline: Date;
  readonly discordActorId: string;
  readonly executionInteractionId: string;
  readonly localActorId: string;
  readonly reason: string;
  readonly sourceApplicationId: string;
  readonly sourceChannelId: string;
  readonly sourceGuildId: string;
  readonly sourceInteractionId: string;
};

export type DiscordAdminJobStageResult =
  | { readonly commandDigest: string; readonly kind: "duplicate" | "staged" }
  | { readonly kind: "expired" | "security_conflict" };

export type DiscordAdminJobActivationResult =
  | { readonly kind: "acknowledged" }
  | { readonly kind: "not_pending" | "security_conflict" };

export async function stageDiscordAdminReasonDraft(
  input: DiscordAdminReasonDraftInput
): Promise<DiscordAdminJobStageResult> {
  const identity = { ...input, executionInteractionId: null, reason: null };
  const commandDigest = buildDiscordAdminCommandDigest(identity);
  return withSystemContext(async (transaction) => {
    const insertion = await transaction.discordAdminCommandJob.createMany({
      data: {
        commandDigest,
        discordActorId: input.discordActorId,
        draftIntent: input.draftIntent,
        expiresAt: new Date(input.now.getTime() + DRAFT_RETENTION_MS),
        handshakeStatus: "AWAITING_REASON",
        ipHash: input.ipHash,
        localActorId: input.localActorId,
        sourceApplicationId: input.sourceApplicationId,
        sourceChannelId: input.sourceChannelId,
        sourceGuildId: input.sourceGuildId,
        sourceInteractionId: input.sourceInteractionId,
        status: "DRAFT"
      },
      skipDuplicates: true
    });
    if (insertion.count === 1) return { commandDigest, kind: "staged" };
    const existing = await transaction.discordAdminCommandJob.findUnique({
      select: { commandDigest: true, status: true },
      where: { sourceInteractionId: input.sourceInteractionId }
    });
    return existing?.commandDigest === commandDigest && existing.status === "DRAFT"
      ? { commandDigest, kind: "duplicate" }
      : { kind: "security_conflict" };
  });
}

export async function stageDiscordAdminCommand(
  input: DiscordAdminCommandStageInput
): Promise<DiscordAdminJobStageResult> {
  const identity = { ...input, reason: null };
  const commandDigest = buildDiscordAdminCommandDigest(identity);
  return withSystemContext(async (transaction) => {
    const insertion = await transaction.discordAdminCommandJob.createMany({
      data: {
        commandDigest,
        discordActorId: input.discordActorId,
        draftIntent: input.draftIntent,
        executionInteractionId: input.executionInteractionId,
        expiresAt: new Date(input.activationDeadline.getTime() + JOB_RETENTION_MS),
        handshakeStatus: "STAGED",
        ipHash: input.ipHash,
        localActorId: input.localActorId,
        nextAttemptAt: input.activationDeadline,
        sourceApplicationId: input.sourceApplicationId,
        sourceChannelId: input.sourceChannelId,
        sourceGuildId: input.sourceGuildId,
        sourceInteractionId: input.sourceInteractionId,
        status: "PENDING"
      },
      skipDuplicates: true
    });
    if (insertion.count === 1) return { commandDigest, kind: "staged" };
    return duplicateResult(transaction, input.executionInteractionId, commandDigest);
  });
}

export async function attachDiscordAdminCommandReason(
  input: DiscordAdminReasonActivationInput
): Promise<DiscordAdminJobStageResult> {
  return withSystemContext(async (transaction) => {
    const existing = await transaction.discordAdminCommandJob.findUnique({
      where: { sourceInteractionId: input.sourceInteractionId }
    });
    if (existing === null) return { kind: "expired" };
    const identity = jobIdentity(existing, input.executionInteractionId, input.reason);
    const commandDigest = buildDiscordAdminCommandDigest(identity);
    const contextMatches = existing.discordActorId === input.discordActorId && existing.localActorId === input.localActorId &&
      existing.sourceApplicationId === input.sourceApplicationId && existing.sourceChannelId === input.sourceChannelId &&
      existing.sourceGuildId === input.sourceGuildId;
    if (!contextMatches) return { kind: "security_conflict" };
    const updated = await transaction.discordAdminCommandJob.updateMany({
      data: {
        commandDigest,
        executionInteractionId: input.executionInteractionId,
        expiresAt: new Date(input.activationDeadline.getTime() + JOB_RETENTION_MS),
        handshakeStatus: "STAGED",
        nextAttemptAt: input.activationDeadline,
        reason: input.reason,
        status: "PENDING"
      },
      where: {
        executionInteractionId: null,
        expiresAt: { gt: new Date() },
        handshakeStatus: "AWAITING_REASON",
        id: existing.id,
        status: "DRAFT"
      }
    });
    if (updated.count === 1) return { commandDigest, kind: "staged" };
    return existing.executionInteractionId === input.executionInteractionId && existing.commandDigest === commandDigest
      ? { commandDigest, kind: "duplicate" }
      : { kind: "expired" };
  });
}

export function activateDiscordAdminCommandJob(input: {
  readonly commandDigest: string;
  readonly executionInteractionId: string;
}): Promise<DiscordAdminJobActivationResult> {
  return withSystemContext(async (transaction) => {
    const updated = await transaction.$executeRaw(Prisma.sql`
      WITH clock AS (SELECT clock_timestamp() AS "now")
      UPDATE "DiscordAdminCommandJob" AS job
      SET "handshakeStatus" = 'ACKNOWLEDGED', "nextAttemptAt" = clock."now", "updatedAt" = clock."now"
      FROM clock
      WHERE job."commandDigest" = ${input.commandDigest}
        AND job."executionInteractionId" = ${input.executionInteractionId}
        AND job."handshakeStatus" = 'STAGED'
        AND job."nextAttemptAt" > clock."now"
        AND job."status" = 'PENDING'
    `);
    if (updated === 1) return { kind: "acknowledged" };
    const current = await transaction.discordAdminCommandJob.findUnique({
      select: { commandDigest: true, handshakeStatus: true, status: true },
      where: { executionInteractionId: input.executionInteractionId }
    });
    if (current !== null && current.commandDigest !== input.commandDigest) return { kind: "security_conflict" };
    return current?.handshakeStatus === "ACKNOWLEDGED" && current.status === "PENDING"
      ? { kind: "acknowledged" }
      : { kind: "not_pending" };
  });
}

async function duplicateResult(
  transaction: Prisma.TransactionClient,
  executionInteractionId: string,
  commandDigest: string
): Promise<DiscordAdminJobStageResult> {
  const existing = await transaction.discordAdminCommandJob.findFirst({
    select: { commandDigest: true },
    where: { OR: [{ executionInteractionId }, { sourceInteractionId: executionInteractionId }] }
  });
  return existing?.commandDigest === commandDigest
    ? { commandDigest, kind: "duplicate" }
    : { kind: "security_conflict" };
}

function jobIdentity(
  job: {
    readonly discordActorId: string;
    readonly draftIntent: string;
    readonly ipHash: string;
    readonly localActorId: string;
    readonly sourceApplicationId: string;
    readonly sourceChannelId: string;
    readonly sourceGuildId: string;
    readonly sourceInteractionId: string;
  },
  executionInteractionId: string,
  reason: string
): DiscordAdminCommandIdentity {
  return { ...job, executionInteractionId, reason };
}

function withSystemContext<TResult>(
  operation: (transaction: Prisma.TransactionClient) => Promise<TResult>
): Promise<TResult> {
  return withDatabaseContext({ actor: systemDatabaseActor(), client: prisma, operation });
}
