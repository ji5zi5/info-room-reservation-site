import { addDays, toKstDate } from "./date";

export type AdvanceReservationPolicy =
  | {
      readonly kind: "available";
      readonly maxDate: string;
      readonly minDate: string;
      readonly today: string;
    }
  | {
      readonly kind: "unavailable";
      readonly message: "사전예약 불가";
      readonly today: string;
    };

export function getAdvanceReservationPolicy(now: Date): AdvanceReservationPolicy {
  const today = toKstDate(now);
  const dayOfWeek = getKstDayOfWeek(today);
  if (dayOfWeek < 1 || dayOfWeek >= 5) {
    return { kind: "unavailable", message: "사전예약 불가", today };
  }

  return {
    kind: "available",
    maxDate: addDays(today, 5 - dayOfWeek),
    minDate: addDays(today, 1),
    today
  };
}

export function isReservableDate(date: string, now: Date): boolean {
  const policy = getAdvanceReservationPolicy(now);
  if (date === policy.today) {
    return true;
  }
  return isSelectableAdvanceDate(date, policy);
}

export function isSelectableAdvanceDate(date: string, policy: AdvanceReservationPolicy): boolean {
  if (policy.kind === "unavailable") {
    return false;
  }
  return date >= policy.minDate && date <= policy.maxDate;
}

function getKstDayOfWeek(dateText: string): number {
  return new Date(`${dateText}T12:00:00+09:00`).getUTCDay();
}
