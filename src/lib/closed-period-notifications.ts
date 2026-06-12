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
  const kst = getKstDateTime(now);
  if (kst.date > setting.date) {
    return true;
  }
  if (kst.date < setting.date) {
    return false;
  }
  return toMinutes(kst.time) > toMinutes(setting.closeTime);
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

function getKstDateTime(date: Date): { readonly date: string; readonly time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Seoul",
    year: "numeric"
  }).formatToParts(date);

  const year = getDatePart(parts, "year");
  const month = getDatePart(parts, "month");
  const day = getDatePart(parts, "day");
  const hour = getDatePart(parts, "hour");
  const minute = getDatePart(parts, "minute");

  return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}` };
}

function getDatePart(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const part = parts.find((candidate) => candidate.type === type);
  if (!part) {
    throw new ClosedPeriodDateFormatError(type);
  }
  return part.value;
}

function toMinutes(time: string): number {
  const [hourText, minuteText] = time.split(":");
  const hour = Number.parseInt(hourText ?? "", 10);
  const minute = Number.parseInt(minuteText ?? "", 10);
  return hour * 60 + minute;
}

class ClosedPeriodDateFormatError extends Error {
  public constructor(part: Intl.DateTimeFormatPartTypes) {
    super(`KST date part not found: ${part}`);
    this.name = "ClosedPeriodDateFormatError";
  }
}
