import { addDays } from "./date";
import { GLOBAL_PERIOD_SETTINGS_DATE } from "./period-setting-values";
import { DEFAULT_PERIOD_CAPACITY, getStudyPeriodLabel, isStudyPeriod, STUDY_PERIODS, type StudyPeriod } from "./study-periods";

export type AdminStatisticsReservationRow = {
  readonly date: string;
  readonly status: string;
  readonly studyPeriod: string;
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly studentNumber: string;
  };
};

export type AdminStatisticsPeriodSettingRow = {
  readonly capacity: number;
  readonly date: string;
  readonly studyPeriod: string;
};

export type CountSummary = {
  readonly cancelledCount: number;
  readonly confirmedCount: number;
  readonly noShowCount: number;
  readonly totalCount: number;
};

export type AdminPeriodStatistics = CountSummary & {
  readonly capacity: number;
  readonly fillRate: number;
  readonly label: string;
  readonly studyPeriod: StudyPeriod;
};

export type AdminDailyStatistics = CountSummary & {
  readonly date: string;
};

export type AdminRepeatedOffender = {
  readonly cancelledCount: number;
  readonly name: string;
  readonly noShowCount: number;
  readonly studentNumber: string;
  readonly totalIncidents: number;
  readonly userId: string;
};

export type AdminStatistics = {
  readonly dailyStats: readonly AdminDailyStatistics[];
  readonly from: string;
  readonly periodStats: readonly AdminPeriodStatistics[];
  readonly repeatedOffenders: readonly AdminRepeatedOffender[];
  readonly to: string;
  readonly totals: CountSummary & { readonly uniqueStudentCount: number };
};

const EMPTY_COUNTS: CountSummary = {
  cancelledCount: 0,
  confirmedCount: 0,
  noShowCount: 0,
  totalCount: 0
};

export function buildAdminStatistics(input: {
  readonly from: string;
  readonly reservations: readonly AdminStatisticsReservationRow[];
  readonly settings: readonly AdminStatisticsPeriodSettingRow[];
  readonly to: string;
}): AdminStatistics {
  const knownReservations = input.reservations.filter((reservation) => isStudyPeriod(reservation.studyPeriod));
  const uniqueStudentIds = new Set(knownReservations.map((reservation) => reservation.user.id));

  return {
    dailyStats: buildDailyStats(knownReservations),
    from: input.from,
    periodStats: buildPeriodStats({
      from: input.from,
      reservations: knownReservations,
      settings: input.settings,
      to: input.to
    }),
    repeatedOffenders: buildRepeatedOffenders(knownReservations),
    to: input.to,
    totals: { ...countReservations(knownReservations), uniqueStudentCount: uniqueStudentIds.size }
  };
}

function buildPeriodStats(input: {
  readonly from: string;
  readonly reservations: readonly AdminStatisticsReservationRow[];
  readonly settings: readonly AdminStatisticsPeriodSettingRow[];
  readonly to: string;
}): readonly AdminPeriodStatistics[] {
  const dates = dateRange(input.from, input.to);
  const settingsByDatePeriod = new Map(input.settings.map((setting) => [settingKey(setting.date, setting.studyPeriod), setting]));
  return STUDY_PERIODS.map((studyPeriod) => {
    const counts = countReservations(input.reservations.filter((reservation) => reservation.studyPeriod === studyPeriod));
    const capacity = dates.reduce(
      (sum, date) => sum + capacityForDatePeriod(settingsByDatePeriod, date, studyPeriod),
      0
    );
    return {
      ...counts,
      capacity,
      fillRate: capacity === 0 ? 0 : roundPercent((counts.confirmedCount / capacity) * 100),
      label: getStudyPeriodLabel(studyPeriod),
      studyPeriod
    };
  });
}

function dateRange(from: string, to: string): readonly string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

function settingKey(date: string, studyPeriod: string): string {
  return `${date}:${studyPeriod}`;
}

function capacityForDatePeriod(
  settingsByDatePeriod: ReadonlyMap<string, AdminStatisticsPeriodSettingRow>,
  date: string,
  studyPeriod: StudyPeriod
): number {
  return (
    settingsByDatePeriod.get(settingKey(date, studyPeriod))?.capacity ??
    settingsByDatePeriod.get(settingKey(GLOBAL_PERIOD_SETTINGS_DATE, studyPeriod))?.capacity ??
    DEFAULT_PERIOD_CAPACITY
  );
}

function buildDailyStats(reservations: readonly AdminStatisticsReservationRow[]): readonly AdminDailyStatistics[] {
  const byDate = new Map<string, CountSummary>();
  for (const reservation of reservations) {
    byDate.set(reservation.date, incrementCounts(byDate.get(reservation.date) ?? EMPTY_COUNTS, reservation.status));
  }
  return [...byDate.entries()]
    .sort(([leftDate], [rightDate]) => leftDate.localeCompare(rightDate))
    .map(([date, counts]) => ({ ...counts, date }));
}

function buildRepeatedOffenders(reservations: readonly AdminStatisticsReservationRow[]): readonly AdminRepeatedOffender[] {
  const offenders = new Map<string, AdminRepeatedOffender>();
  for (const reservation of reservations) {
    if (reservation.status !== "CANCELLED" && reservation.status !== "NO_SHOW") {
      continue;
    }
    const current = offenders.get(reservation.user.id) ?? {
      cancelledCount: 0,
      name: reservation.user.name,
      noShowCount: 0,
      studentNumber: reservation.user.studentNumber,
      totalIncidents: 0,
      userId: reservation.user.id
    };
    offenders.set(reservation.user.id, {
      ...current,
      cancelledCount: current.cancelledCount + (reservation.status === "CANCELLED" ? 1 : 0),
      noShowCount: current.noShowCount + (reservation.status === "NO_SHOW" ? 1 : 0),
      totalIncidents: current.totalIncidents + 1
    });
  }
  return [...offenders.values()]
    .filter((offender) => offender.totalIncidents >= 2)
    .sort((left, right) => right.totalIncidents - left.totalIncidents || left.studentNumber.localeCompare(right.studentNumber))
    .slice(0, 10);
}

function countReservations(reservations: readonly Pick<AdminStatisticsReservationRow, "status">[]): CountSummary {
  return reservations.reduce((counts, reservation) => incrementCounts(counts, reservation.status), EMPTY_COUNTS);
}

function incrementCounts(counts: CountSummary, status: string): CountSummary {
  switch (status) {
    case "CANCELLED":
      return { ...counts, cancelledCount: counts.cancelledCount + 1, totalCount: counts.totalCount + 1 };
    case "CONFIRMED":
      return { ...counts, confirmedCount: counts.confirmedCount + 1, totalCount: counts.totalCount + 1 };
    case "NO_SHOW":
      return { ...counts, noShowCount: counts.noShowCount + 1, totalCount: counts.totalCount + 1 };
    default:
      return counts;
  }
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}
