import { randomUUID } from "node:crypto";

import { Prisma, type DiscordReservationMessage } from "@prisma/client";

import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";
import type { MaintenanceExpiryBatchResult } from "./maintenance-service";

export const DISCORD_CLAIM_BATCH_SIZE = 20;
export const DISCORD_CLAIM_LEASE_MS = 120_000;
export const DISCORD_CLEANUP_BATCH_SIZE = 100;
const DISCORD_MAX_RETRY_DELAY_MS = 60 * 60 * 1_000, DISCORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type DiscordInitialSendClaim = Readonly<{ attempts: number; claimId: string; nonce: string; outcome: string | null; reservationId: string }>;
export type DiscordMessageSyncClaim = Readonly<{ attempts: number; channelId: string; claimId: string; guildId: string; messageId: string; reservationId: string; revision: number }>;
export type DiscordMessageSyncState = Readonly<{ cancellationReason: string | null; decision: string | null }>;
type ReceiptWrite = Readonly<{
  discordActorId: string; interactionId: string; intent: string; localActorId: string;
  messageId: string | null; reservationId: string; status: "TERMINAL";
  terminalOutcome: string; terminalResult: Prisma.InputJsonValue }>;

type ReceiptTransaction = { readonly discordInteractionReceipt: { readonly createMany: (input: Prisma.DiscordInteractionReceiptCreateManyArgs) => Promise<Prisma.BatchPayload>; readonly findUnique: (input: Prisma.DiscordInteractionReceiptFindUniqueArgs) => Promise<{ readonly terminalResult: Prisma.JsonValue } | null> } };
type DecisionTransaction = { readonly discordReservationMessage: { readonly updateMany: (input: Prisma.DiscordReservationMessageUpdateManyArgs) => Promise<Prisma.BatchPayload> } };

export const prismaDiscordReservationMessageRepository = {
  async bumpMessageRevision(reservationId: string, now: Date): Promise<boolean> {
    return withSystemContext(async (transaction) => {
      const result = await transaction.discordReservationMessage.updateMany({
        data: {
          messageRevision: { increment: 1 },
          syncClaimId: null,
          syncClaimRevision: null,
          syncClaimedAt: null,
          syncError: null,
          syncNextAttemptAt: now,
          syncStatus: "PENDING"
        },
        where: { reservationId }
      });
      return result.count === 1;
    });
  },

  async beginInitialSendTerminalDelivery(input: {
    readonly claimId: string;
    readonly outcome: string;
    readonly reservationId: string;
  }): Promise<boolean> {
    return conditionalUpdate(input.reservationId, {
      initialSendOutcome: input.outcome
    }, {
      initialSendClaimId: input.claimId,
      initialSendStatus: "SENDING"
    });
  },

  async claimInitialSend(now: Date, reservationId: string): Promise<DiscordInitialSendClaim | null> {
    const claims = await claimInitialSends(now, reservationId, 1);
    return claims[0] ?? null;
  },

  async claimInitialSends(now: Date): Promise<readonly DiscordInitialSendClaim[]> {
    return claimInitialSends(now, undefined, DISCORD_CLAIM_BATCH_SIZE);
  },

  async claimMessageSyncs(now: Date): Promise<readonly DiscordMessageSyncClaim[]> {
    return withSystemContext(async (transaction) => {
      const staleBefore = new Date(now.getTime() - DISCORD_CLAIM_LEASE_MS);
      const claimable = syncClaimableWhere(now, staleBefore);
      const candidates = await transaction.discordReservationMessage.findMany({
        orderBy: [{ syncNextAttemptAt: "asc" }, { reservationId: "asc" }],
        take: DISCORD_CLAIM_BATCH_SIZE,
        where: { ...claimable, channelId: { not: null }, guildId: { not: null }, messageId: { not: null } }
      });
      const claims: DiscordMessageSyncClaim[] = [];
      for (const candidate of candidates.slice(0, DISCORD_CLAIM_BATCH_SIZE)) {
        if (!candidate.channelId || !candidate.guildId || !candidate.messageId || candidate.messageRevision <= candidate.syncedRevision) {
          continue;
        }
        const claimId = randomUUID();
        const result = await transaction.discordReservationMessage.updateMany({
          data: {
            syncAttempts: { increment: 1 },
            syncClaimedAt: now,
            syncClaimId: claimId,
            syncClaimRevision: candidate.messageRevision,
            syncError: null,
            syncStatus: "SYNCING"
          },
          where: { ...claimable, messageRevision: candidate.messageRevision, reservationId: candidate.reservationId }
        });
        if (result.count === 1) {
          claims.push({ attempts: candidate.syncAttempts + 1, channelId: candidate.channelId, claimId, guildId: candidate.guildId, messageId: candidate.messageId, reservationId: candidate.reservationId, revision: candidate.messageRevision });
        }
      }
      return claims;
    });
  },

  async readMessageSyncState(reservationId: string): Promise<DiscordMessageSyncState | null> {
    return withSystemContext(async (transaction) => {
      const [message, cancellationAction] = await Promise.all([
        transaction.discordReservationMessage.findUnique({
          select: { decision: true },
          where: { reservationId }
        }),
        transaction.adminAction.findFirst({
          orderBy: { createdAt: "desc" },
          select: { reason: true },
          where: { action: "ADMIN_RESERVATION_CANCEL", reservationId }
        })
      ]);
      return message === null
        ? null
        : { cancellationReason: cancellationAction?.reason ?? null, decision: message.decision };
    });
  },

  async create(input: { readonly nonce: string; readonly reservationId: string; readonly now: Date }): Promise<DiscordReservationMessage> {
    return withSystemContext((transaction) => createDiscordReservationMessage(transaction, input));
  },

  async deleteExpiredInteractionReceipts(now: Date): Promise<MaintenanceExpiryBatchResult> {
    return withSystemContext(async (transaction) => {
      const candidates = await transaction.discordInteractionReceipt.findMany({
        orderBy: [{ expiresAt: "asc" }, { interactionId: "asc" }],
        select: { interactionId: true },
        take: DISCORD_CLEANUP_BATCH_SIZE + 1,
        where: { expiresAt: { lte: now }, status: "TERMINAL" }
      });
      const ids = candidates.slice(0, DISCORD_CLEANUP_BATCH_SIZE).map((row) => row.interactionId);
      const processedCount = ids.length === 0 ? 0 : (await transaction.discordInteractionReceipt.deleteMany({ where: { interactionId: { in: ids }, expiresAt: { lte: now }, status: "TERMINAL" } })).count;
      return cleanupResult(candidates.length, processedCount);
    });
  },

  async deleteExpiredMessages(now: Date): Promise<MaintenanceExpiryBatchResult> {
    return withSystemContext(async (transaction) => {
      const terminal = terminalMessageWhere(now);
      const candidates = await transaction.discordReservationMessage.findMany({
        orderBy: [{ expiresAt: "asc" }, { reservationId: "asc" }],
        select: { reservationId: true },
        take: DISCORD_CLEANUP_BATCH_SIZE + 1,
        where: terminal
      });
      const ids = candidates.slice(0, DISCORD_CLEANUP_BATCH_SIZE).map((row) => row.reservationId);
      const processedCount = ids.length === 0 ? 0 : (await transaction.discordReservationMessage.deleteMany({ where: { ...terminal, reservationId: { in: ids } } })).count;
      return cleanupResult(candidates.length, processedCount);
    });
  },

  async saveInitialSendSuccess(input: { readonly channelId: string; readonly claimId: string; readonly guildId: string; readonly messageId: string; readonly reservationId: string; readonly sentAt: Date }): Promise<boolean> {
    return withSystemContext(async (transaction) => {
      const common = { channelId: input.channelId, guildId: input.guildId, initialSendClaimId: null,
        initialSendClaimedAt: null, initialSendNextAttemptAt: null, initialSendOutcome: "SENT",
        initialSendStatus: "SENT", messageId: input.messageId } satisfies Prisma.DiscordReservationMessageUpdateManyMutationInput;
      const where = { initialSendClaimId: input.claimId, initialSendStatus: "SENDING", reservationId: input.reservationId } satisfies Prisma.DiscordReservationMessageWhereInput;
      const current = await transaction.discordReservationMessage.updateMany({
        data: { ...common, syncNextAttemptAt: null, syncStatus: "SYNCED" }, where: { ...where, messageRevision: 0 }
      });
      if (current.count === 1) return true;
      const newer = await transaction.discordReservationMessage.updateMany({
        data: { ...common, syncNextAttemptAt: input.sentAt, syncStatus: "PENDING" }, where: { ...where, messageRevision: { gt: 0 } }
      });
      return newer.count === 1;
    });
  },

  async saveInitialSendFailure(input: { readonly attempts: number; readonly claimId: string; readonly error: string; readonly now: Date; readonly outcome: string; readonly reservationId: string; readonly retryable: boolean }): Promise<boolean> {
    return conditionalUpdate(input.reservationId, {
      initialSendClaimId: null,
      initialSendClaimedAt: null,
      initialSendError: input.error,
      initialSendNextAttemptAt: input.retryable ? cappedDiscordRetryAt(input.now, input.attempts) : null,
      initialSendOutcome: input.outcome,
      initialSendStatus: input.retryable ? "RETRY" : "ABANDONED",
      ...(!input.retryable ? { syncStatus: "ABANDONED" } : {})
    }, { initialSendClaimId: input.claimId, initialSendStatus: "SENDING" });
  },

  async saveSyncSuccess(input: { readonly claimId: string; readonly reservationId: string; readonly revision: number; readonly syncedAt: Date }): Promise<boolean> {
    return conditionalUpdate(input.reservationId, {
      syncClaimId: null, syncClaimRevision: null, syncClaimedAt: null, syncError: null,
      syncedRevision: input.revision, syncNextAttemptAt: null, syncStatus: "SYNCED"
    }, { messageRevision: input.revision, syncClaimId: input.claimId, syncClaimRevision: input.revision, syncStatus: "SYNCING" });
  },

  async saveSyncFailure(input: { readonly attempts: number; readonly claimId: string; readonly error: string; readonly now: Date; readonly reservationId: string; readonly retryable: boolean; readonly revision: number }): Promise<boolean> {
    return conditionalUpdate(input.reservationId, {
      syncClaimId: null,
      syncClaimRevision: null,
      syncClaimedAt: null,
      syncError: input.error,
      syncNextAttemptAt: input.retryable ? cappedDiscordRetryAt(input.now, input.attempts) : null,
      syncStatus: input.retryable ? "RETRY" : "ABANDONED"
    }, { messageRevision: input.revision, syncClaimId: input.claimId, syncClaimRevision: input.revision, syncStatus: "SYNCING" });
  }
} as const;

async function claimInitialSends(
  now: Date,
  reservationId: string | undefined,
  limit: number
): Promise<readonly DiscordInitialSendClaim[]> {
  return withSystemContext(async (transaction) => {
    const staleBefore = new Date(now.getTime() - DISCORD_CLAIM_LEASE_MS);
    const claimable = initialSendClaimableWhere(now, staleBefore);
    const candidates = await transaction.discordReservationMessage.findMany({
      orderBy: [{ initialSendNextAttemptAt: "asc" }, { reservationId: "asc" }],
      select: { initialSendAttempts: true, initialSendOutcome: true, nonce: true, reservationId: true },
      take: limit,
      where: { ...claimable, ...(reservationId === undefined ? {} : { reservationId }) }
    });
    const claims: DiscordInitialSendClaim[] = [];
    for (const candidate of candidates.slice(0, limit)) {
      const claimId = randomUUID();
      const result = await transaction.discordReservationMessage.updateMany({
        data: {
          initialSendAttempts: { increment: 1 },
          initialSendClaimedAt: now,
          initialSendClaimId: claimId,
          initialSendError: null,
          initialSendStatus: "SENDING"
        },
        where: { ...claimable, reservationId: candidate.reservationId }
      });
      if (result.count === 1) {
        claims.push({
          attempts: candidate.initialSendAttempts + 1,
          claimId,
          nonce: candidate.nonce,
          outcome: candidate.initialSendOutcome,
          reservationId: candidate.reservationId
        });
      }
    }
    return claims;
  });
}

export function cappedDiscordRetryAt(now: Date, attempts: number): Date {
  const delay = Math.min(60_000 * 2 ** Math.max(0, attempts - 1), DISCORD_MAX_RETRY_DELAY_MS);
  return new Date(now.getTime() + delay);
}

export function createDiscordReservationMessage(transaction: Prisma.TransactionClient, input: Readonly<{ nonce: string; now: Date; reservationId: string }>): Promise<DiscordReservationMessage> {
  return transaction.discordReservationMessage.create({
    data: {
      expiresAt: new Date(input.now.getTime() + DISCORD_RETENTION_MS),
      initialSendNextAttemptAt: input.now,
      nonce: input.nonce,
      reservationId: input.reservationId
    }
  });
}

export async function recordDiscordInteractionReceipt(transaction: ReceiptTransaction, input: ReceiptWrite): Promise<{ readonly kind: "inserted" | "replayed"; readonly terminalResult: Prisma.JsonValue }> {
  const insertion = await transaction.discordInteractionReceipt.createMany({ data: input, skipDuplicates: true });
  const terminalResult = await findDiscordInteractionTerminalResult(transaction, input);
  if (terminalResult === null) {
    throw new DiscordInteractionReceiptConflictError(input.interactionId);
  }
  return { kind: insertion.count === 1 ? "inserted" : "replayed", terminalResult };
}

export async function findDiscordInteractionTerminalResult(transaction: ReceiptTransaction, input: Readonly<{ interactionId: string; reservationId: string }>): Promise<Prisma.JsonValue | null> {
  const receipt = await transaction.discordInteractionReceipt.findUnique({ where: { interactionId: input.interactionId } })
    ?? await transaction.discordInteractionReceipt.findUnique({ where: { reservationId: input.reservationId } });
  return receipt?.terminalResult ?? null;
}

export async function recordDiscordReservationDecision(transaction: DecisionTransaction, input: Readonly<{ decision: string; discordActorId: string; localActorId: string; now: Date; reservationId: string; revision: "INCREMENT" | "PRESERVE" }>): Promise<boolean> {
  const revisionUpdate = input.revision === "INCREMENT" ? {
    messageRevision: { increment: 1 },
    syncAttempts: 0,
    syncClaimId: null,
    syncClaimRevision: null,
    syncClaimedAt: null,
    syncError: null,
    syncNextAttemptAt: input.now,
    syncStatus: "PENDING"
  } satisfies Prisma.DiscordReservationMessageUpdateManyMutationInput : {};
  const result = await transaction.discordReservationMessage.updateMany({
    data: {
      decidedAt: input.now,
      decision: input.decision,
      decisionDiscordActorId: input.discordActorId,
      decisionLocalActorId: input.localActorId,
      ...revisionUpdate
    },
    where: { decision: null, reservationId: input.reservationId }
  });
  return result.count === 1;
}

function initialSendClaimableWhere(now: Date, staleBefore: Date): Prisma.DiscordReservationMessageWhereInput {
  return { OR: [{ initialSendNextAttemptAt: { lte: now }, initialSendStatus: { in: ["PENDING", "RETRY"] } },
    { initialSendClaimedAt: { lte: staleBefore }, initialSendStatus: "SENDING" }] };
}

function syncClaimableWhere(now: Date, staleBefore: Date): Prisma.DiscordReservationMessageWhereInput {
  return { OR: [{ syncNextAttemptAt: { lte: now }, syncStatus: { in: ["PENDING", "RETRY"] } },
    { syncClaimedAt: { lte: staleBefore }, syncStatus: "SYNCING" }] };
}

const terminalMessageWhere = (now: Date): Prisma.DiscordReservationMessageWhereInput =>
  ({ expiresAt: { lte: now }, initialSendStatus: { in: ["SENT", "ABANDONED"] }, syncStatus: { in: ["SYNCED", "ABANDONED"] } });

async function conditionalUpdate(reservationId: string, data: Prisma.DiscordReservationMessageUpdateManyMutationInput, where: Prisma.DiscordReservationMessageWhereInput): Promise<boolean> {
  return withSystemContext(async (transaction) => (await transaction.discordReservationMessage.updateMany({ data, where: { ...where, reservationId } })).count === 1);
}

function cleanupResult(candidateCount: number, processedCount: number): MaintenanceExpiryBatchResult {
  return { hasMore: candidateCount > DISCORD_CLEANUP_BATCH_SIZE, processedCount, remainingLowerBound: candidateCount > DISCORD_CLEANUP_BATCH_SIZE ? 1 : 0 };
}

const withSystemContext = <TResult>(operation: (transaction: Prisma.TransactionClient) => Promise<TResult>): Promise<TResult> =>
  withDatabaseContext({ actor: systemDatabaseActor(), client: prisma, operation });

class DiscordInteractionReceiptConflictError extends Error {
  public constructor(id: string) { super(`Discord interaction receipt conflict could not be replayed: ${id}`); this.name = "DiscordInteractionReceiptConflictError"; }
}
