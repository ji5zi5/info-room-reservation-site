import type { DiscordApplicationConfig } from "./discord-app-config";
import { buildDiscordReservationInitialMessage } from "./discord-reservation-messages";
import type { DiscordReservationSnapshot } from "./discord-reservation-snapshot";
import { ServerEnvError } from "./env";
import type { NotificationSettings } from "./notification-settings";
import type { DiscordInitialSendClaim } from "./prisma-discord-reservation-message-repository";
import type { ReservationCreatedNotificationResult } from "./reservation-created-notification-service";
import type { Reservation } from "./reservation-service";
import type {
  DiscordReservationOutboxDependencies,
  InitialClaimResult
} from "./discord-reservation-outbox-contracts";
import { evaluateDiscordOperationFence } from "./discord-operations-repair-policy";
import type { DiscordOperationsControlState } from "./discord-operations-repair-policy";

// allow: SIZE_OK — This file is the auditable initial-send state machine plus its legacy webhook boundary.
const INITIAL_POST_DEADLINE_MS = 10_000;

export type { InitialClaimResult } from "./discord-reservation-outbox-contracts";

export async function reconcileExpiredDiscordInitialPosts(
  dependencies: DiscordReservationOutboxDependencies,
  now: Date
): Promise<number> {
  return (await getReconciliationRepository(dependencies.repository)?.reconcileExpiredInitialPosts(now)) ?? 0;
}

export async function processDiscordInitialClaim(
  dependencies: DiscordReservationOutboxDependencies,
  claim: DiscordInitialSendClaim,
  now: Date
): Promise<InitialClaimResult> {
  try {
    const [snapshotResult, settings] = await Promise.all([
      dependencies.loadSnapshot(claim.reservationId),
      dependencies.getNotificationSettings()
    ]);
    if (snapshotResult.kind !== "ready") {
      await saveTerminalInitial(dependencies, claim, now, `SKIPPED_${snapshotResult.kind.toUpperCase()}`);
      return "terminal";
    }
    if (!settings.reservationCreatedNotificationsEnabled) {
      await saveTerminalInitial(dependencies, claim, now, "SKIPPED_DISABLED");
      return "terminal";
    }
    if (claim.outcome?.endsWith("_STARTED") === true) {
      const interruptedOutcome = `${claim.outcome.slice(0, -"_STARTED".length)}_INTERRUPTED`;
      await saveTerminalInitial(dependencies, claim, now, interruptedOutcome);
      return "terminal";
    }

    let config: DiscordApplicationConfig | null;
    try {
      config = dependencies.getApplicationConfig();
    } catch (error) {
      if (!(error instanceof ServerEnvError)) {
        throw error;
      }
      await saveTerminalInitial(dependencies, claim, now, "SKIPPED_CONFIG_INVALID");
      return "terminal";
    }
    if (config === null) {
      return finishWebhookDelivery(dependencies, claim, snapshotResult.snapshot, settings, now, "WEBHOOK");
    }
    const operationsRepository = getOperationsRepository(dependencies.repository);
    const control = await operationsRepository?.readOperationsControl() ?? {
      enabled: true,
      epoch: 0,
      pendingRemoteCleanup: false
    };
    const fence = evaluateDiscordOperationFence({
      control,
      expectedEpoch: control.epoch,
      stage: "INITIAL_POST"
    });
    switch (fence.kind) {
      case "allowed":
        break;
      case "disabled":
      case "draining":
      case "stale_epoch":
        await dependencies.repository.saveInitialSendFailure({
          attempts: claim.attempts,
          claimId: claim.claimId,
          error: fence.kind,
          now,
          outcome: fence.kind.toUpperCase(),
          reservationId: claim.reservationId,
          retryable: true
        });
        return "retried";
    }
    const posting = await operationsRepository?.beginInitialSendPost({
      boundary: "INITIAL_CREATE",
      claimId: claim.claimId,
      deadlineAt: new Date(now.getTime() + INITIAL_POST_DEADLINE_MS),
      epoch: fence.epoch,
      nonce: claim.nonce,
      operationId: claim.claimId,
      reservationId: claim.reservationId
    }) ?? true;
    if (!posting) {
      await markPendingReview(dependencies, claim, "POSTING_CAS_REJECTED");
      return "review";
    }
    return deliverInitialPost(dependencies, claim, snapshotResult.snapshot, config, fence.epoch, now);
  } catch (error) {
    await dependencies.repository.saveInitialSendFailure({
      attempts: claim.attempts,
      claimId: claim.claimId,
      error: errorMessage(error),
      now,
      outcome: "UNEXPECTED_ERROR",
      reservationId: claim.reservationId,
      retryable: true
    });
    return "retried";
  }
}

async function deliverInitialPost(
  dependencies: DiscordReservationOutboxDependencies,
  claim: DiscordInitialSendClaim,
  snapshot: DiscordReservationSnapshot,
  config: DiscordApplicationConfig,
  renderedEpoch: number,
  now: Date
): Promise<InitialClaimResult> {
  try {
    const delivery = await dependencies.bot.createChannelMessage({
      channelId: config.channelId,
      payload: buildDiscordReservationInitialMessage({
        ...messageInput(snapshot),
        customIdSecret: config.botToken,
        renderedEpoch
      }),
      reservationId: claim.reservationId
    });
    switch (delivery.kind) {
      case "sent": {
        const saved = await dependencies.repository.saveInitialSendSuccess({
          channelId: config.channelId,
          claimId: claim.claimId,
          guildId: config.guildId,
          messageId: delivery.messageId,
          renderedSourceEpoch: renderedEpoch,
          reservationId: claim.reservationId,
          sentAt: now
        });
        if (saved) {
          return "sent";
        }
        await markPendingReview(dependencies, claim, "RESULT_PERSISTENCE_FAILED");
        return "review";
      }
      case "unknown":
        await markPendingReview(dependencies, claim, delivery.outcome);
        return "review";
      case "failed": {
        const saved = await dependencies.repository.saveInitialSendFailure({
          attempts: claim.attempts,
          claimId: claim.claimId,
          error: delivery.message,
          now,
          outcome: delivery.outcome,
          reservationId: claim.reservationId,
          retryable: true
        });
        if (saved) {
          return "retried";
        }
        await markPendingReview(dependencies, claim, "RESULT_PERSISTENCE_FAILED");
        return "review";
      }
    }
  } catch {
    await markPendingReview(dependencies, claim, "RESULT_PERSISTENCE_FAILED");
    return "review";
  }
}

async function markPendingReview(
  dependencies: DiscordReservationOutboxDependencies,
  claim: DiscordInitialSendClaim,
  reason: string
): Promise<void> {
  const operationsRepository = getOperationsRepository(dependencies.repository);
  if (operationsRepository === null) {
    return;
  }
  await Promise.allSettled([
    operationsRepository.markInitialSendPendingReview({
      claimId: claim.claimId,
      reason,
      reservationId: claim.reservationId
    })
  ]);
}

type OutboxRepository = DiscordReservationOutboxDependencies["repository"];
type OperationsRepository = OutboxRepository & {
  readonly beginInitialSendPost: (input: {
    readonly boundary: string;
    readonly claimId: string;
    readonly deadlineAt: Date;
    readonly epoch: number;
    readonly nonce: string;
    readonly operationId: string;
    readonly reservationId: string;
  }) => Promise<boolean>;
  readonly markInitialSendPendingReview: (input: {
    readonly claimId: string;
    readonly reason: string;
    readonly reservationId: string;
  }) => Promise<boolean>;
  readonly readOperationsControl: () => Promise<DiscordOperationsControlState>;
};
type ReconciliationRepository = OutboxRepository & {
  readonly reconcileExpiredInitialPosts: (now: Date) => Promise<number>;
};

function getOperationsRepository(repository: OutboxRepository): OperationsRepository | null {
  return isOperationsRepository(repository) ? repository : null;
}

function isOperationsRepository(repository: OutboxRepository): repository is OperationsRepository {
  if (
    "beginInitialSendPost" in repository
    && typeof repository.beginInitialSendPost === "function"
    && "markInitialSendPendingReview" in repository
    && typeof repository.markInitialSendPendingReview === "function"
    && "readOperationsControl" in repository
    && typeof repository.readOperationsControl === "function"
  ) {
    return true;
  }
  return false;
}

function getReconciliationRepository(repository: OutboxRepository): ReconciliationRepository | null {
  return isReconciliationRepository(repository) ? repository : null;
}

function isReconciliationRepository(repository: OutboxRepository): repository is ReconciliationRepository {
  return "reconcileExpiredInitialPosts" in repository
    && typeof repository.reconcileExpiredInitialPosts === "function";
}

async function finishWebhookDelivery(
  dependencies: DiscordReservationOutboxDependencies,
  claim: DiscordInitialSendClaim,
  snapshot: DiscordReservationSnapshot,
  settings: NotificationSettings,
  now: Date,
  prefix: "WEBHOOK" | "WEBHOOK_FALLBACK"
): Promise<InitialClaimResult> {
  const webhookUrl = dependencies.getWebhookUrl();
  const started = await dependencies.repository.beginInitialSendTerminalDelivery({
    claimId: claim.claimId,
    outcome: `${prefix}_STARTED`,
    reservationId: claim.reservationId
  });
  if (!started) {
    return "terminal";
  }
  try {
    const result = await dependencies.sendWebhook({
      applicant: snapshot.reservation.user,
      notificationSettings: settings,
      reservation: reservationFromSnapshot(snapshot),
      webhookUrl
    });
    const terminal = webhookTerminalResult(prefix, result);
    await dependencies.repository.saveInitialSendFailure({
      attempts: claim.attempts,
      claimId: claim.claimId,
      error: terminal.error,
      now,
      outcome: terminal.outcome,
      reservationId: claim.reservationId,
      retryable: false
    });
    return "terminal";
  } catch (error) {
    await Promise.allSettled([
      dependencies.repository.saveInitialSendFailure({
        attempts: claim.attempts,
        claimId: claim.claimId,
        error: errorMessage(error),
        now,
        outcome: `${prefix}_INTERRUPTED`,
        reservationId: claim.reservationId,
        retryable: false
      })
    ]);
    return "terminal";
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

function reservationFromSnapshot(snapshot: DiscordReservationSnapshot): Reservation {
  return {
    date: snapshot.reservation.date,
    id: snapshot.reservation.id,
    reason: snapshot.reservation.reason,
    status: snapshot.reservation.status,
    studyPeriod: snapshot.reservation.studyPeriod,
    userId: snapshot.reservation.userId
  };
}

function webhookTerminalResult(
  prefix: "WEBHOOK" | "WEBHOOK_FALLBACK",
  result: ReservationCreatedNotificationResult
): { readonly error: string; readonly outcome: string } {
  switch (result.kind) {
    case "sent":
      return { error: "", outcome: `${prefix}_SENT` };
    case "failed":
      return { error: result.message, outcome: `${prefix}_FAILED` };
    case "skipped":
      return { error: result.reason, outcome: `${prefix}_${result.reason.toUpperCase()}` };
  }
}

async function saveTerminalInitial(
  dependencies: DiscordReservationOutboxDependencies,
  claim: DiscordInitialSendClaim,
  now: Date,
  outcome: string
): Promise<void> {
  await dependencies.repository.saveInitialSendFailure({
    attempts: claim.attempts,
    claimId: claim.claimId,
    error: outcome,
    now,
    outcome,
    reservationId: claim.reservationId,
    retryable: false
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Discord reservation outbox error";
}
