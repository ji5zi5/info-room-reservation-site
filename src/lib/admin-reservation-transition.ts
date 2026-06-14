export function canAdminCancelReservation(status: string): boolean {
  return status === "CONFIRMED";
}

export function canMarkReservationNoShow(status: string): boolean {
  return status === "CONFIRMED";
}
