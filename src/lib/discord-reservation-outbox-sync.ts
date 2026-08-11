import {
  buildDiscordReservationAcceptedMessage,
  buildDiscordReservationCancelledMessage,
  buildDiscordReservationStaleMessage
} from "./discord-reservation-messages";
import type { DiscordReservationSnapshot } from "./discord-reservation-snapshot";
import type {
  DiscordMessageSyncClaim,
  DiscordMessageSyncState
} from "./prisma-discord-reservation-message-repository";
import type { DiscordReservationOutboxDependencies } from "./discord-reservation-outbox-contracts";

const MAX_SYNC_ATTEMPTS = 5;

export type SyncClaimResult = "abandoned" | "retried" | "synced";

export async function processDiscordSyncClaim(
  dependencies: DiscordReservationOutboxDependencies,
  claim: DiscordMessageSyncClaim,
  now: Date
): Promise<SyncClaimResult> {
  try {
    const [snapshotResult, state] = await Promise.all([
      dependencies.loadSnapshot(claim.reservationId),
      dependencies.repository.readMessageSyncState(claim.reservationId)
    ]);
    const config = dependencies.getApplicationConfig();
    if (snapshotResult.kind === "not_found" || state === null || config === null) {
      return saveSyncError(dependencies, claim, now, "discord_source_unavailable");
    }
    const delivery = await dependencies.bot.editChannelMessage({
      channelId: claim.channelId,
      messageId: claim.messageId,
      payload: syncPayload(snapshotResult.snapshot, state)
    });
    switch (delivery.kind) {
      case "sent":
        await dependencies.repository.saveSyncSuccess({
          claimId: claim.claimId,
          reservationId: claim.reservationId,
          revision: claim.revision,
          syncedAt: now
        });
        return "synced";
      case "unknown":
      case "failed":
        return saveSyncError(dependencies, claim, now, delivery.message);
    }
  } catch (error) {
    return saveSyncError(dependencies, claim, now, errorMessage(error));
  }
}

async function saveSyncError(
  dependencies: DiscordReservationOutboxDependencies,
  claim: DiscordMessageSyncClaim,
  now: Date,
  error: string
): Promise<SyncClaimResult> {
  const retryable = claim.attempts < MAX_SYNC_ATTEMPTS;
  await dependencies.repository.saveSyncFailure({
    attempts: claim.attempts,
    claimId: claim.claimId,
    error,
    now,
    reservationId: claim.reservationId,
    retryable,
    revision: claim.revision
  });
  return retryable ? "retried" : "abandoned";
}

function syncPayload(snapshot: DiscordReservationSnapshot, state: DiscordMessageSyncState) {
  const input = messageInput(snapshot);
  switch (snapshot.reservation.status) {
    case "CANCELLED":
      return buildDiscordReservationCancelledMessage({
        ...input,
        cancellationReason: state.cancellationReason ?? "취소 사유 미기록"
      });
    case "NO_SHOW":
      return buildDiscordReservationStaleMessage(input);
    case "CONFIRMED":
      return state.decision === "ACCEPTED"
        ? buildDiscordReservationAcceptedMessage(input)
        : buildDiscordReservationStaleMessage(input);
  }
}

function messageInput(snapshot: DiscordReservationSnapshot) {
  return {
    applicant: snapshot.reservation.user,
    capacity: snapshot.capacity,
    closeTime: snapshot.effectiveSetting.closeTime,
    confirmedCount: snapshot.confirmedCount,
    date: snapshot.reservation.date,
    reason: snapshot.reservation.reason,
    reservationId: snapshot.reservation.id,
    studyPeriod: snapshot.reservation.studyPeriod
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Discord reservation outbox error";
}
