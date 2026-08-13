import { addDays, toKstDate } from "./date";
import { getStudyPeriodLabel, STUDY_PERIODS, type StudyPeriod } from "./study-periods";

export type StudentStatusUser = {
  readonly bookingStatus: string;
  readonly id: string;
  readonly restrictionReason: string | null;
  readonly restrictedUntil: string | null;
  readonly studentNumber: string;
};

type StudentStatusPeriod = {
  readonly myReservationId: string | null;
  readonly studyPeriod: StudyPeriod;
};

export class StudentCurrentReservation {
  public constructor(
    public readonly date: string,
    public readonly studyPeriod: StudyPeriod,
    public readonly reservationId: string
  ) {}

  public get label(): string {
    return getStudyPeriodLabel(this.studyPeriod);
  }
}

export function collectStudentCurrentReservations(
  periodsByDate: Readonly<Record<string, readonly StudentStatusPeriod[] | undefined>>,
  now: Date = new Date()
): readonly StudentCurrentReservation[] {
  const today = toKstDate(now);
  const activeWeekStart = addDays(today, mondayOffset(today));
  const activeWeekEnd = addDays(activeWeekStart, 4);

  return Object.entries(periodsByDate)
    .filter(([date]) => date >= today && date >= activeWeekStart && date <= activeWeekEnd)
    .flatMap(([date, periods]) =>
      (periods ?? [])
        .flatMap((period) =>
          period.myReservationId === null
            ? []
            : [
                new StudentCurrentReservation(date, period.studyPeriod, period.myReservationId)
              ]
        )
    )
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        STUDY_PERIODS.indexOf(left.studyPeriod) - STUDY_PERIODS.indexOf(right.studyPeriod)
    );
}

export function isStudentRestrictionActive(user: StudentStatusUser, now = new Date()): boolean {
  if (user.bookingStatus === "BANNED") {
    return true;
  }
  if (user.bookingStatus !== "RESTRICTED") {
    return false;
  }
  if (!user.restrictedUntil) {
    return true;
  }
  return Date.parse(user.restrictedUntil) > now.getTime();
}

export function studentReservationStatusLabel(user: StudentStatusUser, now = new Date()): string {
  if (user.bookingStatus === "BANNED") {
    return "예약 제한";
  }
  return isStudentRestrictionActive(user, now) ? "제한 중" : "예약 가능";
}

export function nextReservableAtLabel(user: StudentStatusUser, now = new Date()): string {
  if (user.bookingStatus === "BANNED") {
    return "관리자 확인 필요";
  }
  if (isStudentRestrictionActive(user, now)) {
    return user.restrictedUntil ? formatKstDateTime(user.restrictedUntil) : "관리자 확인 필요";
  }
  return "지금 가능";
}

export function restrictionDetailLabel(user: StudentStatusUser, now = new Date()): string {
  if (!isStudentRestrictionActive(user, now)) {
    return "제한 없음";
  }
  const reason = user.restrictionReason ?? "사유 미기록";
  if (!user.restrictedUntil || user.bookingStatus === "BANNED") {
    return reason;
  }
  return `${reason}로 인해 ${formatKstDateTime(user.restrictedUntil)}까지 제한`;
}

export function buildStudentInquiryCode(user: StudentStatusUser): string {
  const suffix = user.restrictedUntil ? compactDateTime(user.restrictedUntil) : user.id.slice(-6);
  return `${user.studentNumber}-${user.bookingStatus}-${suffix}`.toUpperCase();
}

export function previewCancellationRestrictedUntil(now = new Date()): string {
  return new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
}

export function formatKstDateTime(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Seoul",
    year: "numeric"
  }).formatToParts(date);

  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")} ${part(parts, "hour")}:${part(parts, "minute")}`;
}

export function formatKstTime(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat("en-CA", {
    hour: "2-digit",
    hour12: false,
    hourCycle: "h23",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Seoul"
  }).formatToParts(date);

  return `${part(parts, "hour")}:${part(parts, "minute")}:${part(parts, "second")}`;
}

function compactDateTime(value: string): string {
  const formatted = formatKstDateTime(value);
  return formatted.replace(/\D/gu, "").slice(2);
}

function mondayOffset(date: string): number {
  const dayOfWeek = new Date(`${date}T12:00:00+09:00`).getUTCDay();
  return dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
}

function part(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((candidate) => candidate.type === type)?.value ?? "";
}
