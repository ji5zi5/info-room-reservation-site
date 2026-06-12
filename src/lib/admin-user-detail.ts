import { STUDY_PERIODS } from "./study-periods";

export type AdminUserReservationRow = {
  readonly createdAt: Date;
  readonly date: string;
  readonly status: string;
  readonly studyPeriod: string;
  readonly updatedAt: Date;
};

export type AdminUserReservationSummary = {
  readonly cancelledCount: number;
  readonly confirmedCount: number;
  readonly noShowCount: number;
};

export function summarizeAdminUserReservations(
  reservations: readonly Pick<AdminUserReservationRow, "status">[]
): AdminUserReservationSummary {
  return reservations.reduce<AdminUserReservationSummary>(
    (summary, reservation) => {
      switch (reservation.status) {
        case "CANCELLED":
          return { ...summary, cancelledCount: summary.cancelledCount + 1 };
        case "CONFIRMED":
          return { ...summary, confirmedCount: summary.confirmedCount + 1 };
        case "NO_SHOW":
          return { ...summary, noShowCount: summary.noShowCount + 1 };
        default:
          return summary;
      }
    },
    { cancelledCount: 0, confirmedCount: 0, noShowCount: 0 }
  );
}

export function orderAdminUserReservations<T extends AdminUserReservationRow>(reservations: readonly T[]): readonly T[] {
  return [...reservations].sort((left, right) => {
    const dateDelta = right.date.localeCompare(left.date);
    if (dateDelta !== 0) {
      return dateDelta;
    }
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
