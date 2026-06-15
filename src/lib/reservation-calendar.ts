import type { AdvanceReservationPolicy } from "./advance-reservation-policy";
import { addDays } from "./date";

export type ReservationCalendarPeriod = {
  readonly enabled: boolean;
  readonly label: string;
  readonly myReservationId: string | null;
  readonly remaining: number;
  readonly windowState: "closed" | "not_open_yet" | "open";
};

export type ReservationCalendarDay = {
  readonly date: string;
  readonly dayLabel: string;
  readonly isAdvanceWindow: boolean;
  readonly isPast: boolean;
  readonly isToday: boolean;
  readonly selectable: boolean;
};

export type ReservationCalendarStatus = "available" | "closed" | "loading" | "mine" | "unavailable";

export type ReservationCalendarSummary = {
  readonly detail: string;
  readonly status: ReservationCalendarStatus;
  readonly statusLabel: string;
};

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"] as const;

export function buildReservationCalendarDays(policy: AdvanceReservationPolicy): readonly ReservationCalendarDay[] {
  const weekStart = addDays(policy.today, mondayOffset(policy.today));
  return Array.from({ length: 5 }, (_, index) => {
    const date = addDays(weekStart, index);
    return {
      date,
      dayLabel: weekdayLabel(date),
      isAdvanceWindow: isAdvanceReservationDate(date, policy),
      isPast: date < policy.today,
      isToday: date === policy.today,
      selectable: isSelectableReservationCalendarDate(date, policy)
    };
  });
}

export function summarizeReservationCalendarDay(
  day: ReservationCalendarDay,
  periods: readonly ReservationCalendarPeriod[] | undefined
): ReservationCalendarSummary {
  if (!day.selectable) {
    return {
      detail: day.isPast ? "지난 날짜" : "예약 대상 아님",
      status: "unavailable",
      statusLabel: "불가"
    };
  }
  if (!periods) {
    return { detail: "확인 중", status: "loading", statusLabel: "확인 중" };
  }

  const myPeriods = periods.filter((period) => period.myReservationId !== null);
  if (myPeriods.length > 0) {
    return {
      detail: `${labels(myPeriods)} 예약됨`,
      status: "mine",
      statusLabel: "내 예약"
    };
  }

  const availablePeriods = periods.filter(
    (period) => period.enabled && period.remaining > 0 && period.windowState !== "closed"
  );
  if (availablePeriods.length > 0) {
    const waiting = availablePeriods.some((period) => period.windowState === "not_open_yet");
    return {
      detail: waiting ? `${labels(availablePeriods)} 오픈 전` : `${labels(availablePeriods)} 가능`,
      status: "available",
      statusLabel: "예약 가능"
    };
  }

  if (periods.some((period) => period.enabled)) {
    return { detail: "잔여 없음", status: "closed", statusLabel: "마감" };
  }

  return { detail: "운영 불가", status: "unavailable", statusLabel: "불가" };
}

export function isSelectableReservationCalendarDate(date: string, policy: AdvanceReservationPolicy): boolean {
  if (date === policy.today) {
    return true;
  }
  return isAdvanceReservationDate(date, policy);
}

function isAdvanceReservationDate(date: string, policy: AdvanceReservationPolicy): boolean {
  return policy.kind === "available" && date >= policy.minDate && date <= policy.maxDate;
}

function labels(periods: readonly ReservationCalendarPeriod[]): string {
  return periods.map((period) => period.label).join(", ");
}

function mondayOffset(date: string): number {
  const dayOfWeek = getKstDayOfWeek(date);
  return dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
}

function getKstDayOfWeek(date: string): number {
  return new Date(`${date}T12:00:00+09:00`).getUTCDay();
}

function weekdayLabel(date: string): string {
  return WEEKDAY_LABELS[getKstDayOfWeek(date)] ?? "";
}
