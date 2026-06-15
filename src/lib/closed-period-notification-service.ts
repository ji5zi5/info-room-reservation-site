import {
  CLOSED_LIST_NOTIFICATION_KIND,
  isClosedPeriodForNotification,
  isStaleSendingDelivery,
  staleSendingDeliveryCutoff,
  type ClosedPeriodDeliverySnapshot,
  type ClosedPeriodNotificationFinalStatus
} from "./closed-period-notifications";
import { buildClosedPeriodDiscordPayload, type DiscordWebhookPayload, type DiscordWebhookSendResult } from "./discord-notifications";
import type { StudyPeriod } from "./study-periods";

const DISCORD_WEBHOOK_URL_PATTERN =
  /(https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+)\/[^\s"')<>]+/gu;

export type ClosedPeriodNotificationPeriod = {
  readonly applicants: readonly {
    readonly name: string;
    readonly reason: string | null;
    readonly studentNumber: string;
  }[];
  readonly capacity: number;
  readonly closeTime: string;
  readonly confirmedCount: number;
  readonly date: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: StudyPeriod;
};

export type ClosedPeriodNotificationDeliveryWrite = {
  readonly claimUpdatedAt: Date;
  readonly date: string;
  readonly lastError: string | null;
  readonly messageIds: readonly string[];
  readonly status: ClosedPeriodNotificationFinalStatus;
  readonly studyPeriod: StudyPeriod;
};

export type ClosedPeriodNotificationDeliveryRecord = ClosedPeriodDeliverySnapshot & {
  readonly lastError?: string | null;
  readonly messageIds?: readonly string[];
};

export type ClosedPeriodNotificationFinalDeliveryRecord = ClosedPeriodNotificationDeliveryRecord & {
  readonly status: ClosedPeriodNotificationFinalStatus;
};

export interface ClosedPeriodNotificationRepository {
  getDelivery(input: {
    readonly date: string;
    readonly studyPeriod: StudyPeriod;
  }): Promise<ClosedPeriodNotificationDeliveryRecord | null>;
  getPeriod(input: {
    readonly date: string;
    readonly studyPeriod: StudyPeriod;
  }): Promise<ClosedPeriodNotificationPeriod | null>;
  claimDelivery(input: {
    readonly date: string;
    readonly force?: boolean;
    readonly staleSendingBefore: Date;
    readonly studyPeriod: StudyPeriod;
  }): Promise<ClosedPeriodNotificationDeliveryRecord | null>;
  saveDelivery(write: ClosedPeriodNotificationDeliveryWrite): Promise<ClosedPeriodNotificationFinalDeliveryRecord | null>;
}

export type ClosedPeriodNotificationSender = (payload: DiscordWebhookPayload) => Promise<DiscordWebhookSendResult>;

export type ClosedPeriodNotificationService = {
  readonly sendClosedPeriod: (input: SendClosedPeriodInput) => Promise<SendClosedPeriodResult>;
};

type SendClosedPeriodInput = {
  readonly date: string;
  readonly force?: boolean;
  readonly studyPeriod: StudyPeriod;
};

type SendClosedPeriodResult =
  | {
      readonly delivery: ClosedPeriodNotificationFinalDeliveryRecord;
      readonly kind: "failed" | "sent";
    }
  | {
      readonly kind: "skipped";
      readonly reason: "already_sent" | "not_closed" | "not_found";
    };

export function createClosedPeriodNotificationService(input: {
  readonly now: Date;
  readonly repository: ClosedPeriodNotificationRepository;
  readonly sender: ClosedPeriodNotificationSender;
}): ClosedPeriodNotificationService {
  return {
    sendClosedPeriod: async (request) => {
      const period = await input.repository.getPeriod(request);
      if (!period || !period.enabled) {
        return { kind: "skipped", reason: "not_found" };
      }
      if (!isClosedPeriodForNotification(period, input.now)) {
        return { kind: "skipped", reason: "not_closed" };
      }

      const existingDelivery = await input.repository.getDelivery(request);
      if (existingDelivery?.status === "SENDING" && !isStaleSendingDelivery(existingDelivery, input.now)) {
        return { kind: "skipped", reason: "already_sent" };
      }
      if (existingDelivery?.status === "SENT" && request.force !== true) {
        return { kind: "skipped", reason: "already_sent" };
      }

      const deliveryClaim = await input.repository.claimDelivery({
        ...request,
        staleSendingBefore: staleSendingDeliveryCutoff(input.now)
      });
      if (!deliveryClaim) {
        return { kind: "skipped", reason: "already_sent" };
      }
      if (!deliveryClaim.updatedAt) {
        return { kind: "skipped", reason: "already_sent" };
      }

      try {
        const sendResult = await input.sender(buildClosedPeriodDiscordPayload(period));
        const delivery = await input.repository.saveDelivery({
          claimUpdatedAt: deliveryClaim.updatedAt,
          date: request.date,
          lastError: null,
          messageIds: sendResult.messageIds,
          status: "SENT",
          studyPeriod: request.studyPeriod
        });
        if (!delivery) {
          return { kind: "skipped", reason: "already_sent" };
        }
        return { delivery, kind: "sent" };
      } catch (error) {
        const delivery = await input.repository.saveDelivery({
          claimUpdatedAt: deliveryClaim.updatedAt,
          date: request.date,
          lastError: errorMessage(error),
          messageIds: [],
          status: "FAILED",
          studyPeriod: request.studyPeriod
        });
        if (!delivery) {
          return { kind: "skipped", reason: "already_sent" };
        }
        return { delivery, kind: "failed" };
      }
    }
  };
}

export function isClosedListNotificationDelivery(delivery: ClosedPeriodNotificationDeliveryRecord): boolean {
  return delivery.kind === CLOSED_LIST_NOTIFICATION_KIND;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactDiscordWebhookTokens(error.message);
  }
  return "Unknown Discord notification error";
}

function redactDiscordWebhookTokens(message: string): string {
  return message.replace(DISCORD_WEBHOOK_URL_PATTERN, "$1/[redacted]");
}
