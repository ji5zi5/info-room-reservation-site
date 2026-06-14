import { isPeriodWindowClosed } from "./period-window";
import { toKstDate } from "./date";
import type { StudyPeriod } from "./study-periods";

export const CLOSED_LIST_NOTIFICATION_KIND = "CLOSED_LIST";

export type ClosedListNotificationKind = typeof CLOSED_LIST_NOTIFICATION_KIND;

export type ClosedPeriodNotificationStatus = "FAILED" | "SENT";

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
  readonly status: ClosedPeriodNotificationStatus;
  readonly studyPeriod: StudyPeriod;
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
    .filter((setting) => !hasSentDelivery(setting, input.deliveries))
    .sort(compareClosedPeriodCandidates);
}

export function isClosedPeriodForNotification(setting: ClosedPeriodCandidate, now: Date): boolean {
  if (toKstDate(now) < setting.date) {
    return false;
  }
  return isPeriodWindowClosed(setting, now);
}

function hasSentDelivery(
  setting: ClosedPeriodCandidate,
  deliveries: readonly ClosedPeriodDeliverySnapshot[]
): boolean {
  return deliveries.some(
    (delivery) =>
      delivery.date === setting.date &&
      delivery.kind === CLOSED_LIST_NOTIFICATION_KIND &&
      delivery.status === "SENT" &&
      delivery.studyPeriod === setting.studyPeriod
  );
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
