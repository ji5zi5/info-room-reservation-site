import { isReservableDate } from "./advance-reservation-policy";

export function isAllowedPeriodQueryDate(date: string, now: Date): boolean {
  return isReservableDate(date, now);
}
