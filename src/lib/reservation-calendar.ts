import type { AdvanceReservationPolicy } from "./advance-reservation-policy";
import { addDays } from "./date";

export type ReservationCalendarDay = {
  readonly date: string;
  readonly dayLabel: string;
  readonly isAdvanceWindow: boolean;
  readonly isPast: boolean;
  readonly isToday: boolean;
  readonly selectable: boolean;
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

export function isSelectableReservationCalendarDate(date: string, policy: AdvanceReservationPolicy): boolean {
  if (date === policy.today) {
    return true;
  }
  return isAdvanceReservationDate(date, policy);
}

function isAdvanceReservationDate(date: string, policy: AdvanceReservationPolicy): boolean {
  return policy.kind === "available" && date >= policy.minDate && date <= policy.maxDate;
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
