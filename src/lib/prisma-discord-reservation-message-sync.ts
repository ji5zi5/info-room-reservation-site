import { Prisma } from "@prisma/client";

import { withDiscordReservationMessageSystemContext } from "./prisma-discord-reservation-message-context";
import { cappedDiscordRetryAt } from "./prisma-discord-reservation-message-initial-send";

export type DiscordMessageSyncState = Readonly<{
  cancellationReason: string | null;
  decision: string | null;
  decisionDiscordActorId?: string | null;
  decisionLocalActorId?: string | null;
  decidedAt?: Date | null;
  nonce?: string;
  operationIntent?: string;
  renderedSourceEpoch?: number;
}>;

export function bumpMessageRevision(reservationId: string, now: Date): Promise<boolean> {
  return withDiscordReservationMessageSystemContext(async (transaction) => {
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
}

export function beginSyncPatch(input: Readonly<{
  claimId: string;
  deadlineAt: Date;
  epoch: number;
  operationId: string;
  reservationId: string;
  revision: number;
}>): Promise<boolean> {
  return withDiscordReservationMessageSystemContext(async (transaction) => {
    const [control] = await transaction.$queryRaw<readonly {
      readonly enabled: boolean;
      readonly epoch: number;
      readonly pendingRemoteCleanup: boolean;
    }[]>(Prisma.sql`
      SELECT "enabled", "epoch", "pendingRemoteCleanup"
      FROM "DiscordOperationsControl"
      WHERE "id" = 'discord-operations'
      FOR SHARE
    `);
    if (control?.enabled !== true || control.pendingRemoteCleanup || control.epoch !== input.epoch) return false;
    return (await transaction.discordReservationMessage.updateMany({
      data: {
        patchDeadlineAt: input.deadlineAt,
        patchOperationEpoch: input.epoch,
        patchOperationId: input.operationId,
        pendingReviewReason: null,
        remoteVerificationStatus: null,
        syncStatus: "PATCHING"
      },
      where: {
        messageRevision: input.revision,
        reservationId: input.reservationId,
        syncClaimId: input.claimId,
        syncClaimRevision: input.revision,
        syncStatus: "CLAIMED"
      }
    })).count === 1;
  });
}

export function markSyncPendingReview(input: Readonly<{
  claimId: string;
  operationId?: string;
  reason: string;
  reservationId: string;
  revision: number;
}>): Promise<boolean> {
  return conditionalSyncUpdate(input.reservationId, {
    pendingReviewReason: input.reason,
    remoteVerificationStatus: "PENDING",
    syncNextAttemptAt: null,
    syncStatus: "PENDING_REVIEW"
  }, {
    messageRevision: input.revision,
    syncClaimId: input.claimId,
    syncClaimRevision: input.revision,
    ...(input.operationId === undefined
      ? { syncStatus: "CLAIMED" }
      : { patchOperationId: input.operationId, syncStatus: "PATCHING" })
  });
}

export function reconcileExpiredSyncPatches(now: Date): Promise<number> {
  return withDiscordReservationMessageSystemContext(async (transaction) =>
    (await transaction.discordReservationMessage.updateMany({
      data: {
        pendingReviewReason: "PATCHING_EXPIRED",
        remoteVerificationStatus: "PENDING",
        syncNextAttemptAt: null,
        syncStatus: "PENDING_REVIEW"
      },
      where: { patchDeadlineAt: { lte: now }, syncStatus: "PATCHING" }
    })).count
  );
}

export function readMessageSyncState(reservationId: string): Promise<DiscordMessageSyncState | null> {
  return withDiscordReservationMessageSystemContext(async (transaction) => {
    const [message, action, receipts] = await Promise.all([
      transaction.discordReservationMessage.findUnique({
        select: {
          decision: true,
          decisionDiscordActorId: true,
          decisionLocalActorId: true,
          decidedAt: true,
          nonce: true,
          renderedSourceEpoch: true
        },
        where: { reservationId }
      }),
      transaction.adminAction.findFirst({
        orderBy: { createdAt: "desc" },
        select: { reason: true },
        where: { action: { in: ["ADMIN_RESERVATION_CANCEL", "NO_SHOW_BAN"] }, reservationId }
      }),
      transaction.discordInteractionReceipt.findMany({
        orderBy: { createdAt: "desc" },
        select: { intent: true },
        take: 1,
        where: { reservationId, status: "TERMINAL" }
      })
    ]);
    const receipt = receipts[0];
    return message === null
      ? null
      : {
          ...message,
          cancellationReason: action?.reason ?? null,
          ...(receipt === undefined ? {} : { operationIntent: receipt.intent })
        };
  });
}

export function saveSyncFailure(input: {
  readonly attempts: number;
  readonly claimId: string;
  readonly error: string;
  readonly epoch?: number;
  readonly now: Date;
  readonly operationId?: string;
  readonly reservationId: string;
  readonly retryable: boolean;
  readonly revision: number;
}): Promise<boolean> {
  return conditionalSyncUpdate(input.reservationId, {
    syncClaimId: null,
    syncClaimRevision: null,
    syncClaimedAt: null,
    syncError: input.error,
    syncNextAttemptAt: input.retryable ? cappedDiscordRetryAt(input.now, input.attempts) : null,
    syncStatus: input.retryable ? "RETRY" : "ABANDONED"
  }, {
    messageRevision: input.revision,
    syncClaimId: input.claimId,
    syncClaimRevision: input.revision,
    ...(input.operationId === undefined || input.epoch === undefined
      ? { syncStatus: { in: ["CLAIMED", "PATCHING"] } }
      : { patchOperationEpoch: input.epoch, patchOperationId: input.operationId, syncStatus: "PATCHING" })
  });
}

export function saveSyncSuccess(input: {
  readonly claimId: string;
  readonly epoch?: number;
  readonly operationId?: string;
  readonly reservationId: string;
  readonly revision: number;
  readonly syncedAt: Date;
}): Promise<boolean> {
  return conditionalSyncUpdate(input.reservationId, {
    syncClaimId: null,
    syncClaimRevision: null,
    syncClaimedAt: null,
    syncError: null,
    ...(input.epoch === undefined ? {} : { renderedSourceEpoch: input.epoch }),
    syncedRevision: input.revision,
    syncNextAttemptAt: null,
    syncStatus: "SYNCED"
  }, {
    messageRevision: input.revision,
    syncClaimId: input.claimId,
    syncClaimRevision: input.revision,
    ...(input.operationId === undefined || input.epoch === undefined
      ? { syncStatus: { in: ["CLAIMED", "PATCHING"] } }
      : { patchOperationEpoch: input.epoch, patchOperationId: input.operationId, syncStatus: "PATCHING" })
  });
}

export function saveLeasedSyncSuccess(input: {
  readonly claimId: string;
  readonly epoch: number;
  readonly operationId: string;
  readonly reservationId: string;
  readonly revision: number;
  readonly syncedAt: Date;
}): Promise<boolean> {
  return saveSyncSuccess(input);
}

function conditionalSyncUpdate(
  reservationId: string,
  data: Prisma.DiscordReservationMessageUpdateManyMutationInput,
  where: Prisma.DiscordReservationMessageWhereInput
): Promise<boolean> {
  return withDiscordReservationMessageSystemContext(async (transaction) =>
    (await transaction.discordReservationMessage.updateMany({
      data,
      where: { ...where, reservationId }
    })).count === 1
  );
}
