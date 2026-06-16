import { parseAdminReservationStatus } from "@/lib/admin-reservations";

import type { AdminReservationStatusFilter } from "./admin-types";

export function readReservationStatusFromLocation(location: Location): AdminReservationStatusFilter {
  return parseAdminReservationStatus(new URLSearchParams(location.search).get("status"));
}

export function writeReservationStatusToHistory(location: Location, history: History, status: AdminReservationStatusFilter): void {
  const url = new URL(location.href);
  url.searchParams.set("status", status);
  history.replaceState(null, "", `${url.pathname}${url.search}`);
}
