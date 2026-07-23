import { isReservableDate } from "./advance-reservation-policy";
import { addDays, toKstDate } from "./date";

export function isAllowedPeriodQueryDate(date: string, now: Date): boolean {
  return isReservableDate(date, now);
}

export function isAllowedPeriodQueryWeekStart(weekStart: string, now: Date): boolean {
  const today = toKstDate(now);
  const dayOfWeek = new Date(`${today}T12:00:00+09:00`).getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  return weekStart === addDays(today, mondayOffset);
}
