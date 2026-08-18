import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";
import type { DiscordDisablePendingClaim, DiscordDisablePendingRepository } from "./discord-disable-pending";
import type {
  DiscordMessageRetentionCandidate,
  DiscordMessageRetentionRepository
} from "./maintenance-service";
import { DISCORD_CLAIM_BATCH_SIZE, DISCORD_CLAIM_LEASE_MS } from "./prisma-discord-reservation-message-repository";

const DISABLED_DECISION = "DISABLED";
const ROLLBACK_ACTOR = "SYSTEM_ROLLBACK";

const DISCORD_RETENTION_BATCH_SIZE = 100;
const RETENTION_DELETED_STATUS = "RETENTION_DELETED";

const continuationSchema = z.object({
  attemptBoundary: z.string().min(1).nullable(),
  before: z.string().min(1).nullable(),
  complete: z.boolean(),
  lastErrorCode: z.string().min(1).nullable(),
  matchedMessageIds: z.array(z.string().min(1)),
  pagesScanned: z.number().int().nonnegative(),
  status: z.enum(["ERROR", "MULTIPLE", "PARTIAL", "UNIQUE", "ZERO_COMPLETE", "ZERO_PARTIAL"]),
  version: z.literal(1)
}).strict();

type DiscordReservationMaintenanceRepository = DiscordDisablePendingRepository & DiscordMessageRetentionRepository;

export const prismaDiscordReservationMaintenanceRepository: DiscordReservationMaintenanceRepository = {
  async claimActiveMessagesForDisable(now) {
    return withSystemContext(async (transaction) => {
      const claimable = activeDisableWhere(now);
      const candidates = await transaction.discordReservationMessage.findMany({
        orderBy: [{ createdAt: "asc" }, { reservationId: "asc" }],
        select: { channelId: true, messageId: true, messageRevision: true, reservationId: true },
        take: DISCORD_CLAIM_BATCH_SIZE,
        where: claimable
      });
      const claims: DiscordDisablePendingClaim[] = [];
      for (const candidate of candidates) {
        if (candidate.channelId === null || candidate.messageId === null) {
          continue;
        }
        const claimId = randomUUID();
        const result = await transaction.discordReservationMessage.updateMany({
          data: {
            syncClaimedAt: now,
            syncClaimId: claimId,
            syncClaimRevision: candidate.messageRevision,
            syncError: null,
            syncStatus: "SYNCING"
          },
          where: { ...claimable, messageRevision: candidate.messageRevision, reservationId: candidate.reservationId }
        });
        if (result.count === 1) {
          claims.push({
            channelId: candidate.channelId,
            claimId,
            messageId: candidate.messageId,
            reservationId: candidate.reservationId,
            revision: candidate.messageRevision
          });
        }
      }
      return claims;
    });
  },

  async completeDisableClaim(claim, now) {
    return withSystemContext(async (transaction) => {
      const result = await transaction.discordReservationMessage.updateMany({
        data: {
          decidedAt: now,
          decision: DISABLED_DECISION,
          decisionDiscordActorId: ROLLBACK_ACTOR,
          decisionLocalActorId: ROLLBACK_ACTOR,
          syncedRevision: claim.revision,
          syncClaimedAt: null,
          syncClaimId: null,
          syncClaimRevision: null,
          syncError: null,
          syncNextAttemptAt: null,
          syncStatus: "SYNCED"
        },
        where: {
          channelId: claim.channelId,
          decision: null,
          expiresAt: { gt: now },
          initialSendStatus: "SENT",
          messageId: claim.messageId,
          messageRevision: claim.revision,
          reservationId: claim.reservationId,
          syncClaimId: claim.claimId,
          syncClaimRevision: claim.revision,
          syncStatus: "SYNCING"
        }
      });
      return result.count === 1;
    });
  },

  async deleteLocalCandidate(candidate, now) {
    return withSystemContext(async (transaction) => {
      const result = await transaction.discordReservationMessage.deleteMany({
        where: {
          expiresAt: { lte: now },
          initialSendStatus: { in: ["SENT", "ABANDONED"] },
          messageId: null,
          reservationId: candidate.reservationId,
          remoteVerificationStatus: null,
          syncStatus: { in: ["SYNCED", "ABANDONED"] },
          updatedAt: candidate.updatedAt
        }
      });
      return result.count === 1;
    });
  },

  async findExpiredCandidates(now) {
    const rows = await withSystemContext((transaction) => transaction.discordReservationMessage.findMany({
      orderBy: [{ expiresAt: "asc" }, { reservationId: "asc" }],
      select: {
        channelId: true,
        initialSendOutcome: true,
        initialSendStatus: true,
        messageId: true,
        nonce: true,
        postOperationBoundary: true,
        remoteVerificationCursor: true,
        remoteVerificationStatus: true,
        reservationId: true,
        updatedAt: true
      },
      take: DISCORD_RETENTION_BATCH_SIZE + 1,
      where: expiredRetentionWhere(now)
    }));
    return rows.map(toRetentionCandidate);
  },

  async reduceToDeletionTombstone({ candidate, matchCount, now, outcome }) {
    return withSystemContext(async (transaction) => {
      const result = await transaction.discordReservationMessage.updateMany({
        data: deletionTombstoneData(now),
        where: {
          expiresAt: { lte: now },
          reservationId: candidate.reservationId,
          updatedAt: candidate.updatedAt
        }
      });
      if (result.count !== 1) return false;
      await transaction.auditLog.create({
        data: {
          action: outcome === "MULTIPLE"
            ? "DISCORD_RETENTION_MULTIPLE_MESSAGES_DELETED"
            : "DISCORD_RETENTION_MESSAGE_DELETED",
          detail: JSON.stringify({ matchCount, outcome, reservationId: candidate.reservationId })
        }
      });
      return true;
    });
  },

  async saveScanProgress(candidate, continuation, now) {
    return withSystemContext(async (transaction) => {
      const result = await transaction.discordReservationMessage.updateMany({
        data: {
          decisionDiscordActorId: null,
          decisionLocalActorId: null,
          guildId: null,
          initialSendClaimId: null,
          initialSendClaimedAt: null,
          initialSendError: null,
          initialSendNextAttemptAt: null,
          initialSendOutcome: "UNKNOWN",
          initialSendStatus: "PENDING_REVIEW",
          patchDeadlineAt: null,
          patchOperationEpoch: null,
          patchOperationId: null,
          pendingReviewReason: continuation.lastErrorCode ?? continuation.status,
          remoteVerificationCursor: JSON.stringify(continuation),
          remoteVerificationNextAttemptAt: continuation.complete
            ? null
            : new Date(now.getTime() + 60_000),
          remoteVerificationStatus: continuation.status,
          syncClaimId: null,
          syncClaimRevision: null,
          syncClaimedAt: null,
          syncError: null,
          syncNextAttemptAt: null,
          syncStatus: "ABANDONED"
        },
        where: {
          expiresAt: { lte: now },
          messageId: null,
          reservationId: candidate.reservationId,
          updatedAt: candidate.updatedAt
        }
      });
      return result.count === 1;
    });
  },

  async releaseDisableClaim(claim) {
    return withSystemContext(async (transaction) => {
      const result = await transaction.discordReservationMessage.updateMany({
        data: {
          syncClaimedAt: null,
          syncClaimId: null,
          syncClaimRevision: null,
          syncNextAttemptAt: null,
          syncStatus: "PENDING"
        },
        where: {
          decision: null,
          messageRevision: claim.revision,
          reservationId: claim.reservationId,
          syncClaimId: claim.claimId,
          syncClaimRevision: claim.revision,
          syncStatus: "SYNCING"
        }
      });
      return result.count === 1;
    });
  }
};

function activeDisableWhere(now: Date): Prisma.DiscordReservationMessageWhereInput {
  const staleBefore = new Date(now.getTime() - DISCORD_CLAIM_LEASE_MS);
  return {
    channelId: { not: null },
    decision: null,
    expiresAt: { gt: now },
    initialSendStatus: "SENT",
    messageId: { not: null },
    OR: [
      { syncStatus: { in: ["PENDING", "RETRY", "SYNCED", "ABANDONED"] } },
      { syncClaimedAt: { lte: staleBefore }, syncStatus: "SYNCING" }
    ]
  };
}

function expiredRetentionWhere(now: Date): Prisma.DiscordReservationMessageWhereInput {
  return {
    AND: [
      {
        OR: [
          { remoteVerificationStatus: null },
          { remoteVerificationStatus: { not: RETENTION_DELETED_STATUS } }
        ]
      },
      {
        OR: [
          {
            initialSendStatus: { in: ["SENT", "ABANDONED"] },
            messageId: { not: null },
            syncStatus: { in: ["SYNCED", "ABANDONED"] }
          },
          { initialSendStatus: "PENDING_REVIEW", messageId: null },
          { initialSendOutcome: "UNKNOWN", initialSendStatus: "ABANDONED", messageId: null },
          {
            initialSendStatus: "ABANDONED",
            messageId: null,
            remoteVerificationStatus: { not: null }
          },
          {
            initialSendStatus: { in: ["SENT", "ABANDONED"] },
            messageId: null,
            remoteVerificationStatus: null,
            syncStatus: { in: ["SYNCED", "ABANDONED"] }
          }
        ]
      }
    ],
    expiresAt: { lte: now },
  };
}

function toRetentionCandidate(row: {
  readonly channelId: string | null;
  readonly initialSendOutcome: string | null;
  readonly initialSendStatus: string;
  readonly messageId: string | null;
  readonly nonce: string;
  readonly postOperationBoundary: string | null;
  readonly remoteVerificationCursor: string | null;
  readonly remoteVerificationStatus: string | null;
  readonly reservationId: string;
  readonly updatedAt: Date;
}): DiscordMessageRetentionCandidate {
  const unknown = row.messageId === null && (
    row.initialSendStatus === "PENDING_REVIEW"
    || row.initialSendOutcome === "UNKNOWN"
    || row.remoteVerificationStatus !== null
  );
  return {
    attemptBoundary: row.postOperationBoundary,
    channelId: row.channelId,
    continuation: parseContinuation(row.remoteVerificationCursor),
    kind: unknown ? "unknown" : row.messageId === null ? "local" : "known",
    messageId: row.messageId,
    nonce: row.nonce,
    reservationId: row.reservationId,
    updatedAt: row.updatedAt
  };
}

function parseContinuation(value: string | null) {
  if (value === null) return null;
  try {
    return continuationSchema.parse(JSON.parse(value));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new InvalidDiscordRetentionCursorError();
    }
    throw error;
  }
}

function deletionTombstoneData(now: Date): Prisma.DiscordReservationMessageUpdateManyMutationInput {
  return {
    decidedAt: now,
    decision: "RETENTION_DELETED",
    decisionDiscordActorId: null,
    decisionLocalActorId: null,
    guildId: null,
    initialSendClaimId: null,
    initialSendClaimedAt: null,
    initialSendError: null,
    initialSendNextAttemptAt: null,
    initialSendStatus: "ABANDONED",
    messageId: null,
    patchDeadlineAt: null,
    patchOperationEpoch: null,
    patchOperationId: null,
    pendingReviewReason: "RETENTION_DELETED",
    remoteVerificationCursor: null,
    remoteVerificationNextAttemptAt: null,
    remoteVerificationStatus: RETENTION_DELETED_STATUS,
    syncClaimId: null,
    syncClaimRevision: null,
    syncClaimedAt: null,
    syncError: null,
    syncNextAttemptAt: null,
    syncStatus: "ABANDONED"
  };
}

export type PrismaDiscordReadinessState = {
  readonly interactionsEnabled: boolean;
  readonly interactionsRetentionBacklogCount: number;
  readonly reservationOutboxRetentionBacklogCount: number;
};

export function getPrismaDiscordReadinessState(now: Date): Promise<PrismaDiscordReadinessState> {
  return withSystemContext(async (transaction) => {
    const [control, interactionJobs, interactionReceipts, reservationMessages] = await Promise.all([
      transaction.discordOperationsControl.findUnique({
        select: { enabled: true },
        where: { id: "discord-operations" }
      }),
      transaction.discordInteractionJob.count({ where: { expiresAt: { lte: now } } }),
      transaction.discordInteractionReceipt.count({ where: { expiresAt: { lte: now } } }),
      transaction.discordReservationMessage.count({
        where: {
          expiresAt: { lte: now },
          OR: [
            { remoteVerificationStatus: null },
            { remoteVerificationStatus: { not: RETENTION_DELETED_STATUS } }
          ]
        }
      })
    ]);
    return {
      interactionsEnabled: control?.enabled ?? false,
      interactionsRetentionBacklogCount: interactionJobs + interactionReceipts,
      reservationOutboxRetentionBacklogCount: reservationMessages
    };
  });
}

const withSystemContext = <TResult>(
  operation: (transaction: Prisma.TransactionClient) => Promise<TResult>
): Promise<TResult> => withDatabaseContext({ actor: systemDatabaseActor(), client: prisma, operation });

class InvalidDiscordRetentionCursorError extends Error {
  public constructor() {
    super("Stored Discord retention cursor is invalid");
    this.name = "InvalidDiscordRetentionCursorError";
  }
}
