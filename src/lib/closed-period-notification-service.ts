import {
  CLOSED_LIST_NOTIFICATION_KIND,
  isClosedPeriodForNotification,
  isStaleSendingDelivery,
  staleSendingDeliveryCutoff,
  type ClosedPeriodDeliverySnapshot,
  type ClosedPeriodNotificationFinalStatus
} from "./closed-period-notifications";
import {
  buildClosedPeriodDiscordPayload,
  classifyDiscordWebhookError,
  redactDiscordWebhookTokens,
  type DiscordWebhookPayload,
  type DiscordWebhookSendResult
} from "./discord-notifications";
import type { StudyPeriod } from "./study-periods";

export type ClosedPeriodNotificationPeriod = {
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
  readonly failureCode: string | null;
  readonly lastError: string | null;
  readonly messageIds: readonly string[];
  readonly nextAttemptAt: Date | null;
  readonly status: ClosedPeriodNotificationFinalStatus;
  readonly studyPeriod: StudyPeriod;
};

export type ClosedPeriodNotificationDeliveryRecord = ClosedPeriodDeliverySnapshot & {
  readonly failureCode?: string | null;
  readonly lastError?: string | null;
  readonly messageIds?: readonly string[];
};

export type ClosedPeriodNotificationFinalDeliveryRecord = ClosedPeriodNotificationDeliveryRecord & {
  readonly status: ClosedPeriodNotificationFinalStatus;
};

export type ClosedPeriodNotificationReconciliationStatus = "FAILED" | "PENDING_REVIEW" | "UNKNOWN";

export type ClosedPeriodNotificationReconciliationAction = "abandon" | "confirm_sent" | "retry";

export type ClosedPeriodNotificationReconciliationTransition = {
  readonly delivery: ClosedPeriodNotificationDeliveryRecord;
  readonly previousStatus: ClosedPeriodNotificationReconciliationStatus;
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
  claimDeliveryForReconciliation(input: {
    readonly date: string;
    readonly studyPeriod: StudyPeriod;
  }): Promise<ClosedPeriodNotificationReconciliationTransition | null>;
  resolveDelivery(input: {
    readonly action: Exclude<ClosedPeriodNotificationReconciliationAction, "retry">;
    readonly date: string;
    readonly now: Date;
    readonly studyPeriod: StudyPeriod;
  }): Promise<ClosedPeriodNotificationReconciliationTransition | null>;
  saveDelivery(write: ClosedPeriodNotificationDeliveryWrite): Promise<ClosedPeriodNotificationFinalDeliveryRecord | null>;
}

export type ClosedPeriodNotificationSender = (payload: DiscordWebhookPayload) => Promise<DiscordWebhookSendResult>;

export type ClosedPeriodNotificationService = {
  readonly reconcileClosedPeriod: (
    input: ReconcileClosedPeriodInput
  ) => Promise<ReconcileClosedPeriodResult>;
  readonly sendClosedPeriod: (input: SendClosedPeriodInput) => Promise<SendClosedPeriodResult>;
};

type SendClosedPeriodInput = {
  readonly date: string;
  readonly force?: boolean;
  readonly manual?: boolean;
  readonly studyPeriod: StudyPeriod;
};

type ReconcileClosedPeriodInput = {
  readonly action: ClosedPeriodNotificationReconciliationAction;
  readonly date: string;
  readonly studyPeriod: StudyPeriod;
};

type SendClosedPeriodResult =
  | {
      readonly delivery: ClosedPeriodNotificationFinalDeliveryRecord;
      readonly kind: "failed" | "sent" | "unknown";
    }
  | {
      readonly kind: "skipped";
      readonly reason: "already_sent" | "needs_reconciliation" | "not_closed" | "not_found";
    };

export type ReconcileClosedPeriodResult =
  | {
      readonly delivery: ClosedPeriodNotificationDeliveryRecord;
      readonly kind: "abandoned" | "confirmed" | "failed" | "sent" | "unknown";
      readonly previousStatus: ClosedPeriodNotificationReconciliationStatus;
    }
  | { readonly kind: "conflict" };

export function createClosedPeriodNotificationService(input: {
  readonly now: Date;
  readonly repository: ClosedPeriodNotificationRepository;
  readonly sender: ClosedPeriodNotificationSender;
}): ClosedPeriodNotificationService {
  async function deliverClaimedPeriod(
    request: Pick<SendClosedPeriodInput, "date" | "studyPeriod">,
    deliveryClaim: ClosedPeriodNotificationDeliveryRecord,
    period: ClosedPeriodNotificationPeriod
  ): Promise<SendClosedPeriodResult> {
    if (!deliveryClaim.updatedAt) {
      return { kind: "skipped", reason: "already_sent" };
    }

    try {
      const sendResult = await input.sender(buildClosedPeriodDiscordPayload(period));
      const delivery = await input.repository.saveDelivery({
        claimUpdatedAt: deliveryClaim.updatedAt,
        date: request.date,
        failureCode: null,
        lastError: null,
        messageIds: sendResult.messageIds,
        nextAttemptAt: null,
        status: "SENT",
        studyPeriod: request.studyPeriod
      });
      if (!delivery) {
        return { kind: "skipped", reason: "already_sent" };
      }
      return { delivery, kind: "sent" };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error("Unknown Discord notification error");
      const deliveryError = classifyDiscordWebhookError(normalizedError, input.now);
      const delivery = await input.repository.saveDelivery({
        claimUpdatedAt: deliveryClaim.updatedAt,
        date: request.date,
        failureCode: deliveryError.code,
        lastError: errorMessage(deliveryError),
        messageIds: [],
        nextAttemptAt: deliveryError.retryAt,
        status: deliveryError.outcome,
        studyPeriod: request.studyPeriod
      });
      if (!delivery) {
        return { kind: "skipped", reason: "already_sent" };
      }
      return { delivery, kind: deliveryError.outcome === "UNKNOWN" ? "unknown" : "failed" };
    }
  }

  return {
    reconcileClosedPeriod: async (request) => {
      if (request.action !== "retry") {
        const transition = await input.repository.resolveDelivery({
          action: request.action,
          date: request.date,
          now: input.now,
          studyPeriod: request.studyPeriod
        });
        if (!transition) {
          return { kind: "conflict" };
        }
        return {
          ...transition,
          kind: request.action === "confirm_sent" ? "confirmed" : "abandoned"
        };
      }

      const period = await input.repository.getPeriod(request);
      if (!period || !period.enabled || !isClosedPeriodForNotification(period, input.now)) {
        return { kind: "conflict" };
      }
      const transition = await input.repository.claimDeliveryForReconciliation(request);
      if (!transition) {
        return { kind: "conflict" };
      }
      const result = await deliverClaimedPeriod(request, transition.delivery, period);
      if (result.kind === "skipped") {
        return { kind: "conflict" };
      }
      return { ...result, previousStatus: transition.previousStatus };
    },
    sendClosedPeriod: async (request) => {
      const period = await input.repository.getPeriod(request);
      if (!period || !period.enabled) {
        return { kind: "skipped", reason: "not_found" };
      }
      if (!isClosedPeriodForNotification(period, input.now)) {
        return { kind: "skipped", reason: "not_closed" };
      }

      const existingDelivery = await input.repository.getDelivery(request);
      if (
        (request.manual === true && existingDelivery?.status === "FAILED") ||
        existingDelivery?.status === "UNKNOWN" ||
        existingDelivery?.status === "PENDING_REVIEW" ||
        (existingDelivery?.status === "SENDING" && isStaleSendingDelivery(existingDelivery, input.now))
      ) {
        return { kind: "skipped", reason: "needs_reconciliation" };
      }
      if (existingDelivery?.status === "SENDING" && !isStaleSendingDelivery(existingDelivery, input.now)) {
        return { kind: "skipped", reason: "already_sent" };
      }
      if (existingDelivery?.status === "SENT" || existingDelivery?.status === "ABANDONED") {
        return { kind: "skipped", reason: "already_sent" };
      }

      const deliveryClaim = await input.repository.claimDelivery({
        ...request,
        staleSendingBefore: staleSendingDeliveryCutoff(input.now)
      });
      if (!deliveryClaim) {
        return { kind: "skipped", reason: "already_sent" };
      }
      return deliverClaimedPeriod(request, deliveryClaim, period);
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
