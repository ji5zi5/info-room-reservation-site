const COMPACT_RESERVATION_VIEW_QUERY = "(max-width: 850px)";

export function isCompactReservationView(): boolean {
  return typeof window !== "undefined" && window.matchMedia(COMPACT_RESERVATION_VIEW_QUERY).matches;
}
