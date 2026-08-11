import type { DiscordApplicationConfig } from "./discord-app-config";
import {
  createDiscordBotClient,
  type DiscordBotClient,
  type DiscordBotDeliveryResult
} from "./discord-bot";
import { sendDiscordWebhook } from "./discord-notifications";
import {
  buildDiscordReservationAcceptedMessage,
  buildDiscordReservationCancelledMessage,
  buildDiscordReservationInitialMessage,
  buildDiscordReservationStaleMessage
} from "./discord-reservation-messages";
import {
  loadDiscordReservationSnapshot,
  type DiscordReservationSnapshot,
  type DiscordReservationSnapshotResult
} from "./discord-reservation-snapshot";
import { parseServerEnv, ServerEnvError } from "./env";
import { isNoDatabaseMockMode } from "./mock-dev-mode";
import type { NotificationSettings } from "./notification-settings";
import {
  type DiscordInitialSendClaim,
  type DiscordMessageSyncClaim,
  type DiscordMessageSyncState,
  prismaDiscordReservationMessageRepository
} from "./prisma-discord-reservation-message-repository";
import { getPrismaNotificationSettings } from "./prisma-notification-settings";
import {
  sendReservationCreatedNotification,
  type ReservationCreatedNotificationResult
} from "./reservation-created-notification-service";
import type { Reservation } from "./reservation-service";

const MAX_SYNC_ATTEMPTS = 5;

type InitialRunSummary = {
  readonly claimed: number;
  readonly retried: number;
  readonly sent: number;
  readonly terminal: number;
};

type SyncRunSummary = {
  readonly abandoned: number;
  readonly claimed: number;
  readonly retried: number;
  readonly synced: number;
};

export type DiscordReservationOutboxRunResult =
  | { readonly kind: "skipped"; readonly reason: "no_database_mock" }
  | {
      readonly initial: InitialRunSummary;
      readonly kind: "processed";
      readonly sync: SyncRunSummary;
    };

type InitialFailureInput = {
  readonly attempts: number;
  readonly claimId: string;
  readonly error: string;
  readonly now: Date;
  readonly outcome: string;
  readonly reservationId: string;
  readonly retryable: boolean;
};

type InitialSuccessInput = {
  readonly channelId: string;
  readonly claimId: string;
  readonly guildId: string;
  readonly messageId: string;
  readonly reservationId: string;
  readonly sentAt: Date;
};

type SyncFailureInput = {
  readonly attempts: number;
  readonly claimId: string;
  readonly error: string;
  readonly now: Date;
  readonly reservationId: string;
  readonly retryable: boolean;
  readonly revision: number;
};

type SyncSuccessInput = {
  readonly claimId: string;
  readonly reservationId: string;
  readonly revision: number;
  readonly syncedAt: Date;
};

type DiscordReservationOutboxRepository = {
  readonly beginInitialSendTerminalDelivery: (input: {
    readonly claimId: string;
    readonly outcome: string;
    readonly reservationId: string;
  }) => Promise<boolean>;
  readonly claimInitialSend: (now: Date, reservationId: string) => Promise<DiscordInitialSendClaim | null>;
  readonly claimInitialSends: (now: Date) => Promise<readonly DiscordInitialSendClaim[]>;
  readonly claimMessageSync: (now: Date, reservationId: string) => Promise<DiscordMessageSyncClaim | null>;
  readonly claimMessageSyncs: (now: Date) => Promise<readonly DiscordMessageSyncClaim[]>;
  readonly readMessageSyncState: (reservationId: string) => Promise<DiscordMessageSyncState | null>;
  readonly saveInitialSendFailure: (input: InitialFailureInput) => Promise<boolean>;
  readonly saveInitialSendSuccess: (input: InitialSuccessInput) => Promise<boolean>;
  readonly saveSyncFailure: (input: SyncFailureInput) => Promise<boolean>;
  readonly saveSyncSuccess: (input: SyncSuccessInput) => Promise<boolean>;
};

type WebhookDeliveryInput = {
  readonly applicant: { readonly name: string; readonly studentNumber: string };
  readonly notificationSettings: NotificationSettings;
  readonly reservation: Reservation;
  readonly webhookUrl: string | undefined;
};

export type DiscordReservationOutboxDependencies = {
  readonly bot: DiscordBotClient;
  getApplicationConfig: () => DiscordApplicationConfig | null;
  getNotificationSettings: () => Promise<NotificationSettings>;
  getWebhookUrl: () => string | undefined;
  loadSnapshot: (reservationId: string) => Promise<DiscordReservationSnapshotResult>;
  readonly repository: DiscordReservationOutboxRepository;
  readonly sendWebhook: (input: WebhookDeliveryInput) => Promise<ReservationCreatedNotificationResult>;
};

export function createDiscordReservationOutbox(
  dependencies: DiscordReservationOutboxDependencies
): (input: { readonly now: Date; readonly reservationId?: string }) => Promise<Extract<DiscordReservationOutboxRunResult, { readonly kind: "processed" }>> {
  return async (input) => {
    const initialClaims = input.reservationId === undefined
      ? await dependencies.repository.claimInitialSends(input.now)
      : optionalClaim(await dependencies.repository.claimInitialSend(input.now, input.reservationId));
    const initialResults = await Promise.all(initialClaims.map((claim) => processInitialClaim(dependencies, claim, input.now)));
    const syncClaims = input.reservationId === undefined
      ? await dependencies.repository.claimMessageSyncs(input.now)
      : optionalSyncClaim(await dependencies.repository.claimMessageSync(input.now, input.reservationId));
    const syncResults = await Promise.all(syncClaims.map((claim) => processSyncClaim(dependencies, claim, input.now)));
    return {
      initial: summarizeInitial(initialResults),
      kind: "processed",
      sync: summarizeSync(syncResults)
    };
  };
}

export async function runDiscordReservationOutbox(input: {
  readonly now: Date;
  readonly reservationId?: string;
}): Promise<DiscordReservationOutboxRunResult> {
  if (isNoDatabaseMockMode()) {
    return { kind: "skipped", reason: "no_database_mock" };
  }
  return createDiscordReservationOutbox(defaultDependencies())(input);
}

type InitialClaimResult = "retried" | "sent" | "terminal";
type SyncClaimResult = "abandoned" | "retried" | "synced";

async function processInitialClaim(
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
      return finishWebhookDelivery(dependencies, claim, snapshotResult.snapshot, settings, now, "WEBHOOK_FALLBACK");
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
        return finishWebhookDelivery(dependencies, claim, snapshotResult.snapshot, settings, now, "WEBHOOK_FALLBACK");
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
}

async function processSyncClaim(
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

function summarizeInitial(results: readonly InitialClaimResult[]): InitialRunSummary {
  return {
    claimed: results.length,
    retried: results.filter((result) => result === "retried").length,
    sent: results.filter((result) => result === "sent").length,
    terminal: results.filter((result) => result === "terminal").length
  };
}

function summarizeSync(results: readonly SyncClaimResult[]): SyncRunSummary {
  return {
    abandoned: results.filter((result) => result === "abandoned").length,
    claimed: results.length,
    retried: results.filter((result) => result === "retried").length,
    synced: results.filter((result) => result === "synced").length
  };
}

function optionalClaim(claim: DiscordInitialSendClaim | null): readonly DiscordInitialSendClaim[] {
  return claim === null ? [] : [claim];
}

function optionalSyncClaim(claim: DiscordMessageSyncClaim | null): readonly DiscordMessageSyncClaim[] {
  return claim === null ? [] : [claim];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Discord reservation outbox error";
}

function defaultDependencies(): DiscordReservationOutboxDependencies {
  const config = (): DiscordApplicationConfig | null => parseServerEnv().discordApplication;
  const bot = delegatingBotClient(config);
  return {
    bot,
    getApplicationConfig: config,
    getNotificationSettings: getPrismaNotificationSettings,
    getWebhookUrl: () => process.env.DISCORD_WEBHOOK_URL?.trim() || undefined,
    loadSnapshot: loadDiscordReservationSnapshot,
    repository: prismaDiscordReservationMessageRepository,
    sendWebhook: (input) => sendReservationCreatedNotification({
      ...input,
      sender: (payload) => sendDiscordWebhook({ payload, webhookUrl: input.webhookUrl ?? "" })
    })
  };
}

function delegatingBotClient(config: () => DiscordApplicationConfig | null): DiscordBotClient {
  const client = (): DiscordBotClient => {
    const current = config();
    if (current === null) {
      throw new DiscordApplicationUnavailableError();
    }
    return createDiscordBotClient({ applicationId: current.applicationId, botToken: current.botToken });
  };
  return {
    createChannelMessage: (input) => client().createChannelMessage(input),
    editChannelMessage: (input) => client().editChannelMessage(input),
    editOriginalEphemeralResponse: (input) => client().editOriginalEphemeralResponse(input)
  };
}

class DiscordApplicationUnavailableError extends Error {
  public constructor() {
    super("Discord application configuration is unavailable");
    this.name = "DiscordApplicationUnavailableError";
  }
}
