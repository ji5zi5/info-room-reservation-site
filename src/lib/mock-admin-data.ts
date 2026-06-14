import { getMockAdminPeriodSettings } from "./mock-period-settings";
import { STUDY_PERIODS, getStudyPeriodLabel, type StudyPeriod } from "./study-periods";

type CountSummary = {
  readonly cancelledCount: number;
  readonly confirmedCount: number;
  readonly noShowCount: number;
  readonly totalCount: number;
};

type MockAdminDashboardPeriod = ReturnType<typeof getMockAdminPeriodSettings>[number] & {
  readonly isClosed: boolean;
  readonly notification: null;
};

type MockAdminDailyStatistic = CountSummary & {
  readonly date: string;
};

type MockAdminPeriodStatistic = CountSummary & {
  readonly capacity: number;
  readonly fillRate: number;
  readonly label: string;
  readonly studyPeriod: StudyPeriod;
};

type MockAdminStatistics = {
  readonly dailyStats: readonly MockAdminDailyStatistic[];
  readonly from: string;
  readonly periodStats: readonly MockAdminPeriodStatistic[];
  readonly repeatedOffenders: readonly [];
  readonly to: string;
  readonly totals: CountSummary & {
    readonly uniqueStudentCount: number;
  };
};

export function getMockAdminDashboard(date: string, now = new Date()): readonly MockAdminDashboardPeriod[] {
  return getMockAdminPeriodSettings(date, now).map((period) => ({
    ...period,
    isClosed: period.windowState === "closed",
    notification: null
  }));
}

export function getMockAdminStatistics(input: {
  readonly from: string;
  readonly to: string;
}): MockAdminStatistics {
  return {
    dailyStats: datesInRange(input.from, input.to).map((date) => ({
      ...zeroCountSummary(),
      date
    })),
    from: input.from,
    periodStats: STUDY_PERIODS.map((studyPeriod) => ({
      ...zeroCountSummary(),
      capacity: getCapacity(input.from, studyPeriod),
      fillRate: 0,
      label: getStudyPeriodLabel(studyPeriod),
      studyPeriod
    })),
    repeatedOffenders: [],
    to: input.to,
    totals: {
      ...zeroCountSummary(),
      uniqueStudentCount: 0
    }
  };
}

function getCapacity(date: string, studyPeriod: StudyPeriod): number {
  const period = getMockAdminPeriodSettings(date).find((candidate) => candidate.studyPeriod === studyPeriod);
  return period?.capacity ?? 0;
}

function datesInRange(from: string, to: string): readonly string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function zeroCountSummary(): CountSummary {
  return {
    cancelledCount: 0,
    confirmedCount: 0,
    noShowCount: 0,
    totalCount: 0
  };
}
