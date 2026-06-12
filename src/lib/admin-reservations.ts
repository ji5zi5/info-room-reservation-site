import { STUDY_PERIODS } from "./study-periods";

export const ADMIN_RESERVATION_STATUS_FILTERS = ["CONFIRMED", "NO_SHOW", "CANCELLED", "ALL"] as const;
export const ADMIN_RESERVATION_PERIOD_FILTERS = ["EIGHTH", "FIRST", "ALL"] as const;

export type AdminReservationStatusFilter = (typeof ADMIN_RESERVATION_STATUS_FILTERS)[number];
export type AdminReservationStudyPeriodFilter = (typeof ADMIN_RESERVATION_PERIOD_FILTERS)[number];

type AdminReservationRow = {
  readonly createdAt: Date;
  readonly status: string;
  readonly studyPeriod: string;
};

type AdminReservationUserFilterRow = AdminReservationRow & {
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly studentNumber: string;
  };
};

export type AdminReservationQueryFilters = {
  readonly query: string;
  readonly studyPeriod: AdminReservationStudyPeriodFilter;
  readonly userId: string | null;
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

export function parseAdminReservationStudyPeriod(value: string | null): AdminReservationStudyPeriodFilter {
  switch (value) {
    case "EIGHTH":
    case "FIRST":
      return value;
    case "ALL":
    default:
      return "ALL";
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

export function filterAdminReservationsByQuery<T extends AdminReservationUserFilterRow>(
  reservations: readonly T[],
  filters: AdminReservationQueryFilters
): readonly T[] {
  const normalizedQuery = filters.query.trim().toLocaleLowerCase("ko-KR");
  return reservations.filter((reservation) => {
    if (filters.userId !== null && reservation.user.id !== filters.userId) {
      return false;
    }
    if (filters.studyPeriod !== "ALL" && reservation.studyPeriod !== filters.studyPeriod) {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }
    return (
      reservation.user.name.toLocaleLowerCase("ko-KR").includes(normalizedQuery) ||
      reservation.user.studentNumber.toLocaleLowerCase("ko-KR").includes(normalizedQuery)
    );
  });
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
