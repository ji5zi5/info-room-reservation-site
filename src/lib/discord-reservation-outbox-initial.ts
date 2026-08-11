import type { DiscordApplicationConfig } from "./discord-app-config";
import type { DiscordBotDeliveryResult } from "./discord-bot";
import { buildDiscordReservationInitialMessage } from "./discord-reservation-messages";
import type { DiscordReservationSnapshot } from "./discord-reservation-snapshot";
import { ServerEnvError } from "./env";
import type { NotificationSettings } from "./notification-settings";
import type { DiscordInitialSendClaim } from "./prisma-discord-reservation-message-repository";
import type { ReservationCreatedNotificationResult } from "./reservation-created-notification-service";
import type { Reservation } from "./reservation-service";
import type { DiscordReservationOutboxDependencies } from "./discord-reservation-outbox-contracts";

export type InitialClaimResult = "retried" | "sent" | "terminal";

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
    const delivery = await dependencies.bot.createChannelMessage({
      channelId: config.channelId,
      payload: buildDiscordReservationInitialMessage(messageInput(snapshotResult.snapshot)),
      reservationId: claim.reservationId
    });
    switch (delivery.kind) {
      case "sent":
        await dependencies.repository.saveInitialSendSuccess({
          channelId: config.channelId,
          claimId: claim.claimId,
          guildId: config.guildId,
          messageId: delivery.messageId,
          reservationId: claim.reservationId,
          sentAt: now
        });
        return "sent";
      case "unknown":
        await saveRetryableInitial(dependencies, claim, now, delivery);
        return "retried";
      case "failed":
        return finishWebhookDelivery(
          dependencies,
          claim,
          snapshotResult.snapshot,
          settings,
          now,
          "WEBHOOK_FALLBACK"
        );
    }
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

async function saveRetryableInitial(
  dependencies: DiscordReservationOutboxDependencies,
  claim: DiscordInitialSendClaim,
  now: Date,
  delivery: Extract<DiscordBotDeliveryResult, { readonly kind: "unknown" }>
): Promise<void> {
  await dependencies.repository.saveInitialSendFailure({
    attempts: claim.attempts,
    claimId: claim.claimId,
    error: delivery.message,
    now,
    outcome: delivery.outcome,
    reservationId: claim.reservationId,
    retryable: true
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Discord reservation outbox error";
}
