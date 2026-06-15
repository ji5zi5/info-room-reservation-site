import type { PeriodSummary } from "@/components/reservation-period-card";

export function canReservePeriod(period: PeriodSummary | undefined): boolean {
  return Boolean(
    period &&
      period.enabled &&
      period.myReservationId === null &&
      period.remaining > 0 &&
      period.windowState === "open"
  );
}
