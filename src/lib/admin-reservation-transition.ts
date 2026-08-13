import type { PeriodWindowState } from "./period-window";

export function canAdminCancelReservation(status: string): boolean {
  return status === "CONFIRMED";
}

export function canMarkReservationNoShow(status: string, windowState: PeriodWindowState): boolean {
  return status === "CONFIRMED" && windowState === "closed";
}
