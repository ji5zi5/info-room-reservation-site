import type { DiscordApplicationConfig } from "./discord-app-config";
import type { DiscordBotClient } from "./discord-bot";
import type { DiscordReservationSnapshotResult } from "./discord-reservation-snapshot";
import type { NotificationSettings } from "./notification-settings";
import type {
  DiscordInitialSendClaim,
  DiscordMessageSyncClaim,
  DiscordMessageSyncState
} from "./prisma-discord-reservation-message-repository";
import type { ReservationCreatedNotificationResult } from "./reservation-created-notification-service";
import type { Reservation } from "./reservation-service";

export type InitialRunSummary = {
  readonly claimed: number;
  readonly retried: number;
  readonly review: number;
  readonly sent: number;
  readonly terminal: number;
};

export type InitialClaimResult = "retried" | "review" | "sent" | "terminal";

export function summarizeInitialRun(results: readonly InitialClaimResult[]): InitialRunSummary {
  return results.reduce(addInitialResult, {
    claimed: results.length,
    retried: 0,
    review: 0,
    sent: 0,
    terminal: 0
  });
}

function addInitialResult(summary: InitialRunSummary, result: InitialClaimResult): InitialRunSummary {
  switch (result) {
    case "retried":
      return { ...summary, retried: summary.retried + 1 };
    case "review":
      return { ...summary, review: summary.review + 1 };
    case "sent":
      return { ...summary, sent: summary.sent + 1 };
    case "terminal":
      return { ...summary, terminal: summary.terminal + 1 };
    default:
      return assertNeverInitialResult(result);
  }
}

function assertNeverInitialResult(value: never): never {
  throw new InvalidInitialClaimResultError(value);
}

class InvalidInitialClaimResultError extends Error {
  public constructor(readonly value: never) {
    super("Invalid initial Discord outbox claim result");
    this.name = "InvalidInitialClaimResultError";
  }
}

export type SyncRunSummary = {
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
  readonly renderedSourceEpoch: number;
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
