import {
  buildDiscordReservationAcceptedMessage,
  buildDiscordReservationCancelledMessage,
  buildDiscordReservationInitialMessage,
  buildDiscordReservationNoShowMessage,
  buildDiscordReservationStaleMessage
} from "./discord-reservation-messages";
import type { DiscordReservationSnapshot } from "./discord-reservation-snapshot";
import type {
  DiscordMessageSyncClaim,
  DiscordMessageSyncState
} from "./prisma-discord-reservation-message-repository";
import type { prismaDiscordReservationMessageRepository } from "./prisma-discord-reservation-message-repository";
import type { DiscordReservationOutboxDependencies } from "./discord-reservation-outbox-contracts";

const MAX_SYNC_ATTEMPTS = 5;
const PATCH_DEADLINE_MS = 10_000;

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
      return saveSyncError({ claim, dependencies, error: "discord_source_unavailable", now });
    }
    const operations = getSyncOperationsRepository(dependencies.repository);
    if (operations !== null) {
      const control = await operations.readOperationsControl();
      if (!control.enabled || control.pendingRemoteCleanup) {
        return saveSyncError({ claim, dependencies, error: "discord_operations_disabled", now });
      }
      const operationId = claim.claimId;
      const patching = await operations.beginSyncPatch({
        claimId: claim.claimId,
        deadlineAt: new Date(now.getTime() + PATCH_DEADLINE_MS),
        epoch: control.epoch,
        operationId,
        reservationId: claim.reservationId,
        revision: claim.revision
      });
      if (!patching) {
        await operations.markSyncPendingReview({
          claimId: claim.claimId,
          reason: "PATCH_LEASE_REJECTED",
          reservationId: claim.reservationId,
          revision: claim.revision
        });
        return "abandoned";
      }
      return deliverLeasedPatch({
        dependencies: { outbox: dependencies, repository: operations },
        lease: { claim, epoch: control.epoch, now, operationId },
        source: {
          customIdSecret: config.botToken,
          snapshot: snapshotResult.snapshot,
          state
        }
      });
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
        return saveSyncError({ claim, dependencies, error: delivery.message, now });
    }
  } catch (error) { // no-excuse-ok: catch — worker boundary converts unexpected failures into durable retry state.
    return saveSyncError({ claim, dependencies, error: errorMessage(error), now });
  }
}

async function deliverLeasedPatch(input: {
  readonly dependencies: {
    readonly outbox: DiscordReservationOutboxDependencies;
    readonly repository: SyncOperationsRepository;
  };
  readonly lease: {
    readonly claim: DiscordMessageSyncClaim;
    readonly epoch: number;
    readonly now: Date;
    readonly operationId: string;
  };
  readonly source: {
    readonly customIdSecret: string;
    readonly snapshot: DiscordReservationSnapshot;
    readonly state: DiscordMessageSyncState;
  };
}): Promise<SyncClaimResult> {
  const { outbox, repository } = input.dependencies;
  const { claim, epoch, now, operationId } = input.lease;
  const { customIdSecret, snapshot, state } = input.source;
  try {
    const delivery = await outbox.bot.editChannelMessage({
      channelId: claim.channelId,
      messageId: claim.messageId,
      payload: syncPayload(snapshot, state, { customIdSecret, renderedEpoch: epoch })
    });
    switch (delivery.kind) {
      case "sent":
        return await repository.saveLeasedSyncSuccess({
          claimId: claim.claimId,
          epoch,
          operationId,
          reservationId: claim.reservationId,
          revision: claim.revision,
          syncedAt: now
        }) ? "synced" : "abandoned";
      case "failed":
        return saveSyncError({ claim, dependencies: outbox, error: delivery.message, lease: { epoch, operationId }, now });
      case "unknown":
        await repository.markSyncPendingReview({
          claimId: claim.claimId,
          operationId,
          reason: delivery.code,
          reservationId: claim.reservationId,
          revision: claim.revision
        });
        return "abandoned";
    }
  } catch (error) { // no-excuse-ok: catch — an exception after PATCHING is ambiguous and must become review work.
    await repository.markSyncPendingReview({
      claimId: claim.claimId,
      operationId,
      reason: errorMessage(error),
      reservationId: claim.reservationId,
      revision: claim.revision
    });
    return "abandoned";
  }
}

async function saveSyncError(input: {
  readonly claim: DiscordMessageSyncClaim;
  readonly dependencies: DiscordReservationOutboxDependencies;
  readonly error: string;
  readonly lease?: { readonly epoch: number; readonly operationId: string };
  readonly now: Date;
}): Promise<SyncClaimResult> {
  const { claim, dependencies, error, lease, now } = input;
  const retryable = claim.attempts < MAX_SYNC_ATTEMPTS;
  const saved = await dependencies.repository.saveSyncFailure({
    attempts: claim.attempts,
    claimId: claim.claimId,
    error,
    ...(lease === undefined ? {} : lease),
    now,
    reservationId: claim.reservationId,
    retryable,
    revision: claim.revision
  });
  return saved && retryable ? "retried" : "abandoned";
}

function syncPayload(
  snapshot: DiscordReservationSnapshot,
  state: DiscordMessageSyncState,
  render: { readonly customIdSecret?: string; readonly renderedEpoch?: number } = {}
) {
  const customIdSecret = render.customIdSecret ?? process.env.DISCORD_BOT_TOKEN;
  const renderedEpoch = render.renderedEpoch ?? state.renderedSourceEpoch ?? 0;
  const action = syncAction(snapshot, state);
  const input = {
    ...messageInput(snapshot),
    renderedEpoch,
    ...(action === null ? {} : { action }),
    ...(customIdSecret === undefined ? {} : { customIdSecret }),
    ...(state.nonce === undefined ? {} : { sourceIdentity: state.nonce })
  };
  switch (snapshot.reservation.status) {
    case "CANCELLED":
      return buildDiscordReservationCancelledMessage({
        ...input,
        cancellationReason: state.cancellationReason ?? "취소 사유 미기록"
      });
    case "NO_SHOW":
      return buildDiscordReservationNoShowMessage(input);
    case "CONFIRMED":
      if (state.decision === "ACCEPTED") return buildDiscordReservationAcceptedMessage(input);
      return state.decision === null
        ? buildDiscordReservationInitialMessage(input)
        : buildDiscordReservationStaleMessage(input);
  }
}

function syncAction(snapshot: DiscordReservationSnapshot, state: DiscordMessageSyncState) {
  const actor = state.decisionDiscordActorId ?? state.decisionLocalActorId;
  if (actor === undefined || actor === null || state.decidedAt === undefined || state.decidedAt === null) return null;
  const action = operationLabel(state.operationIntent) ?? (snapshot.reservation.status === "NO_SHOW"
    ? "노쇼"
    : snapshot.reservation.status === "CANCELLED"
      ? "관리자 취소"
      : "예약 수락");
  return { actor, at: state.decidedAt, label: action, reason: state.cancellationReason };
}

function operationLabel(intent: string | undefined): string | null {
  switch (intent) {
    case "ACCEPT": return "예약 수락";
    case "REJECT": return "예약 거절";
    case "ADMIN_CANCEL": return "관리자 취소";
    case "NO_SHOW": return "노쇼";
    default: return null;
  }
}

type OutboxRepository = DiscordReservationOutboxDependencies["repository"];
type SyncOperationsRepository = OutboxRepository & Pick<
  typeof prismaDiscordReservationMessageRepository,
  "beginSyncPatch" | "markSyncPendingReview" | "readOperationsControl" | "saveLeasedSyncSuccess"
>;

function getSyncOperationsRepository(repository: OutboxRepository): SyncOperationsRepository | null {
  return isSyncOperationsRepository(repository) ? repository : null;
}

function isSyncOperationsRepository(repository: OutboxRepository): repository is SyncOperationsRepository {
  return "beginSyncPatch" in repository && typeof repository.beginSyncPatch === "function"
    && "markSyncPendingReview" in repository && typeof repository.markSyncPendingReview === "function"
    && "readOperationsControl" in repository && typeof repository.readOperationsControl === "function"
    && "saveLeasedSyncSuccess" in repository && typeof repository.saveLeasedSyncSuccess === "function";
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
