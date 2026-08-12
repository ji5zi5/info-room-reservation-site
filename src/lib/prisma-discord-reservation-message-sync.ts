import type { Prisma } from "@prisma/client";

import { withDiscordReservationMessageSystemContext } from "./prisma-discord-reservation-message-context";
import { cappedDiscordRetryAt } from "./prisma-discord-reservation-message-initial-send";

export type DiscordMessageSyncState = Readonly<{
  cancellationReason: string | null;
  decision: string | null;
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
  return conditionalSyncUpdate(input.reservationId, {
    patchDeadlineAt: input.deadlineAt,
    patchOperationEpoch: input.epoch,
    patchOperationId: input.operationId,
    syncStatus: "PATCHING"
  }, {
    messageRevision: input.revision,
    syncClaimId: input.claimId,
    syncClaimRevision: input.revision,
    syncStatus: "CLAIMED"
  });
}

export function markSyncPendingReview(input: Readonly<{
  claimId: string;
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
    syncStatus: "PATCHING"
  });
}

export function readMessageSyncState(reservationId: string): Promise<DiscordMessageSyncState | null> {
  return withDiscordReservationMessageSystemContext(async (transaction) => {
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
}

export function saveSyncFailure(input: {
  readonly attempts: number;
  readonly claimId: string;
  readonly error: string;
  readonly now: Date;
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
    syncStatus: { in: ["CLAIMED", "PATCHING"] }
  });
}

export function saveSyncSuccess(input: {
  readonly claimId: string;
  readonly reservationId: string;
  readonly revision: number;
  readonly syncedAt: Date;
}): Promise<boolean> {
  return conditionalSyncUpdate(input.reservationId, {
    syncClaimId: null,
    syncClaimRevision: null,
    syncClaimedAt: null,
    syncError: null,
    syncedRevision: input.revision,
    syncNextAttemptAt: null,
    syncStatus: "SYNCED"
  }, {
    messageRevision: input.revision,
    syncClaimId: input.claimId,
    syncClaimRevision: input.revision,
    syncStatus: { in: ["CLAIMED", "PATCHING"] }
  });
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
