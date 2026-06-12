import { STUDY_PERIODS } from "./study-periods";

export const ADMIN_RESERVATION_STATUS_FILTERS = ["CONFIRMED", "NO_SHOW", "CANCELLED", "ALL"] as const;

export type AdminReservationStatusFilter = (typeof ADMIN_RESERVATION_STATUS_FILTERS)[number];

type AdminReservationRow = {
  readonly createdAt: Date;
  readonly status: string;
  readonly studyPeriod: string;
};

export function parseAdminReservationStatus(value: string | null): AdminReservationStatusFilter {
  switch (value) {
    case "ALL":
    case "CANCELLED":
    case "CONFIRMED":
    case "NO_SHOW":
      return value;
    default:
      return "CONFIRMED";
  }
}

export function filterAdminReservations<T extends AdminReservationRow>(
  reservations: readonly T[],
  status: AdminReservationStatusFilter
): readonly T[] {
  if (status === "ALL") {
    return reservations;
  }
  return reservations.filter((reservation) => reservation.status === status);
}

export function orderAdminReservations<T extends AdminReservationRow>(reservations: readonly T[]): readonly T[] {
  return [...reservations].sort((left, right) => {
    const periodDelta = studyPeriodRank(left.studyPeriod) - studyPeriodRank(right.studyPeriod);
    if (periodDelta !== 0) {
      return periodDelta;
    }
    return left.createdAt.getTime() - right.createdAt.getTime();
  });
}

function studyPeriodRank(value: string): number {
  const index = STUDY_PERIODS.findIndex((period) => period === value);
  return index === -1 ? STUDY_PERIODS.length : index;
}
