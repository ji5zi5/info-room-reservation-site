import { isPeriodWindowClosed } from "./period-window";
import { toKstDate } from "./date";
import type { StudyPeriod } from "./study-periods";

export const CLOSED_LIST_NOTIFICATION_KIND = "CLOSED_LIST";

export const SENDING_DELIVERY_STALE_AFTER_MS = 10 * 60 * 1000;

export type ClosedListNotificationKind = typeof CLOSED_LIST_NOTIFICATION_KIND;

export type ClosedPeriodNotificationFinalStatus = "FAILED" | "SENT" | "UNKNOWN";

export type ClosedPeriodNotificationStatus =
  | ClosedPeriodNotificationFinalStatus
  | "ABANDONED"
  | "PENDING"
  | "PENDING_REVIEW"
  | "SENDING";

export type ClosedPeriodCandidate = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly date: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: StudyPeriod;
};

export type ClosedPeriodDeliverySnapshot = {
  readonly date: string;
  readonly kind: string;
  readonly nextAttemptAt?: Date | null;
  readonly status: ClosedPeriodNotificationStatus;
  readonly studyPeriod: StudyPeriod;
  readonly updatedAt?: Date;
};

export type SelectClosedPeriodNotificationCandidatesInput = {
  readonly deliveries: readonly ClosedPeriodDeliverySnapshot[];
  readonly now: Date;
  readonly settings: readonly ClosedPeriodCandidate[];
};

export function selectClosedPeriodNotificationCandidates(
  input: SelectClosedPeriodNotificationCandidatesInput
): readonly ClosedPeriodCandidate[] {
  return input.settings
    .filter((setting) => setting.enabled)
    .filter((setting) => isClosedPeriodForNotification(setting, input.now))
    .filter((setting) => !hasActiveDelivery(setting, input.deliveries, input.now))
    .sort(compareClosedPeriodCandidates);
}

export function isClosedPeriodForNotification(setting: ClosedPeriodCandidate, now: Date): boolean {
  if (toKstDate(now) < setting.date) {
    return false;
  }
  return isPeriodWindowClosed(setting, now);
}

export function staleSendingDeliveryCutoff(now: Date): Date {
  return new Date(now.getTime() - SENDING_DELIVERY_STALE_AFTER_MS);
}

export function isStaleSendingDelivery(
  delivery: Pick<ClosedPeriodDeliverySnapshot, "status" | "updatedAt">,
  now: Date
): boolean {
  if (delivery.status !== "SENDING" || delivery.updatedAt === undefined) {
    return false;
  }
  return delivery.updatedAt.getTime() <= staleSendingDeliveryCutoff(now).getTime();
}

function hasActiveDelivery(
  setting: ClosedPeriodCandidate,
  deliveries: readonly ClosedPeriodDeliverySnapshot[],
  now: Date
): boolean {
  return deliveries.some(
    (delivery) =>
      delivery.date === setting.date &&
      delivery.kind === CLOSED_LIST_NOTIFICATION_KIND &&
      isDeliveryBlockingAutomaticSend(delivery, now) &&
      delivery.studyPeriod === setting.studyPeriod
  );
}

function isDeliveryBlockingAutomaticSend(delivery: ClosedPeriodDeliverySnapshot, now: Date): boolean {
  if (delivery.status === "PENDING") {
    return false;
  }
  if (delivery.status === "FAILED") {
    return delivery.nextAttemptAt !== null && delivery.nextAttemptAt !== undefined && delivery.nextAttemptAt > now;
  }
  return true;
}

function compareClosedPeriodCandidates(left: ClosedPeriodCandidate, right: ClosedPeriodCandidate): number {
  const dateCompare = left.date.localeCompare(right.date);
  if (dateCompare !== 0) {
    return dateCompare;
  }
  return studyPeriodOrder(left.studyPeriod) - studyPeriodOrder(right.studyPeriod);
}

function studyPeriodOrder(studyPeriod: StudyPeriod): number {
  switch (studyPeriod) {
    case "EIGHTH":
      return 0;
    case "FIRST":
      return 1;
  }
}
