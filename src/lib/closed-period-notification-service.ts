import {
  CLOSED_LIST_NOTIFICATION_KIND,
  isClosedPeriodForNotification,
  type ClosedPeriodDeliverySnapshot
} from "./closed-period-notifications";
import { buildClosedPeriodDiscordPayload, type DiscordWebhookPayload, type DiscordWebhookSendResult } from "./discord-notifications";
import type { StudyPeriod } from "./study-periods";

export type ClosedPeriodNotificationPeriod = {
  readonly applicants: readonly {
    readonly name: string;
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
  readonly date: string;
  readonly lastError: string | null;
  readonly messageIds: readonly string[];
  readonly status: "FAILED" | "SENT";
  readonly studyPeriod: StudyPeriod;
};

export type ClosedPeriodNotificationDeliveryRecord = ClosedPeriodDeliverySnapshot & {
  readonly lastError?: string | null;
  readonly messageIds?: readonly string[];
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
  saveDelivery(write: ClosedPeriodNotificationDeliveryWrite): Promise<ClosedPeriodNotificationDeliveryRecord>;
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
      readonly delivery: ClosedPeriodNotificationDeliveryRecord;
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
      if (existingDelivery?.status === "SENT" && request.force !== true) {
        return { kind: "skipped", reason: "already_sent" };
      }

      try {
        const sendResult = await input.sender(buildClosedPeriodDiscordPayload(period));
        const delivery = await input.repository.saveDelivery({
          date: request.date,
          lastError: null,
          messageIds: sendResult.messageIds,
          status: "SENT",
          studyPeriod: request.studyPeriod
        });
        return { delivery, kind: "sent" };
      } catch (error) {
        const delivery = await input.repository.saveDelivery({
          date: request.date,
          lastError: errorMessage(error),
          messageIds: [],
          status: "FAILED",
          studyPeriod: request.studyPeriod
        });
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
    return error.message;
  }
  return "Unknown Discord notification error";
}
