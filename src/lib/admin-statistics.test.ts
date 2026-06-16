import { describe, expect, it } from "vitest";

import { buildAdminStatistics } from "./admin-statistics";
import { GLOBAL_PERIOD_SETTINGS_DATE } from "./period-setting-values";

const studentA = { id: "user-a", name: "김학생", studentNumber: "20101" };
const studentB = { id: "user-b", name: "박반복", studentNumber: "20102" };

describe("buildAdminStatistics", () => {
  it("summarizes totals, period stats, daily stats, and repeated offenders", () => {
    const statistics = buildAdminStatistics({
      from: "2026-06-10",
      reservations: [
        reservation({ date: "2026-06-10", status: "CONFIRMED", studyPeriod: "FIRST", user: studentA }),
        reservation({ date: "2026-06-10", status: "NO_SHOW", studyPeriod: "EIGHTH", user: studentB }),
        reservation({ date: "2026-06-11", status: "CANCELLED", studyPeriod: "EIGHTH", user: studentB })
      ],
      settings: [
        setting({ capacity: 10, date: "2026-06-10", studyPeriod: "EIGHTH" }),
        setting({ capacity: 8, date: "2026-06-10", studyPeriod: "FIRST" }),
        setting({ capacity: 10, date: "2026-06-11", studyPeriod: "EIGHTH" })
      ],
      to: "2026-06-11"
    });

    expect(statistics.totals).toEqual({
      cancelledCount: 1,
      confirmedCount: 1,
      noShowCount: 1,
      totalCount: 3,
      uniqueStudentCount: 2
    });
    expect(statistics.periodStats.map((period) => period.studyPeriod)).toEqual(["EIGHTH", "FIRST"]);
    expect(statistics.periodStats[0]).toMatchObject({
      cancelledCount: 1,
      capacity: 20,
      confirmedCount: 0,
      fillRate: 0,
      label: "8면학",
      noShowCount: 1,
      studyPeriod: "EIGHTH"
    });
    expect(statistics.periodStats[1]).toMatchObject({
      capacity: 18,
      confirmedCount: 1,
      fillRate: 5.6,
      label: "1면학",
      studyPeriod: "FIRST"
    });
    expect(statistics.dailyStats).toEqual([
      { cancelledCount: 0, confirmedCount: 1, date: "2026-06-10", noShowCount: 1, totalCount: 2 },
      { cancelledCount: 1, confirmedCount: 0, date: "2026-06-11", noShowCount: 0, totalCount: 1 }
    ]);
    expect(statistics.repeatedOffenders).toEqual([
      {
        cancelledCount: 1,
        name: "박반복",
        noShowCount: 1,
        studentNumber: "20102",
        totalIncidents: 2,
        userId: "user-b"
      }
    ]);
  });

  it("uses default capacity for date-periods without stored settings", () => {
    const statistics = buildAdminStatistics({
      from: "2026-06-10",
      reservations: [],
      settings: [],
      to: "2026-06-11"
    });

    expect(statistics.periodStats.map((period) => ({ capacity: period.capacity, studyPeriod: period.studyPeriod }))).toEqual([
      { capacity: 20, studyPeriod: "EIGHTH" },
      { capacity: 20, studyPeriod: "FIRST" }
    ]);
  });

  it("uses global capacity for date-periods without stored settings", () => {
    const statistics = buildAdminStatistics({
      from: "2026-06-10",
      reservations: [],
      settings: [
        setting({ capacity: 7, date: GLOBAL_PERIOD_SETTINGS_DATE, studyPeriod: "EIGHTH" }),
        setting({ capacity: 8, date: GLOBAL_PERIOD_SETTINGS_DATE, studyPeriod: "FIRST" }),
        setting({ capacity: 5, date: "2026-06-10", studyPeriod: "EIGHTH" })
      ],
      to: "2026-06-11"
    });

    expect(statistics.periodStats.map((period) => ({ capacity: period.capacity, studyPeriod: period.studyPeriod }))).toEqual([
      { capacity: 12, studyPeriod: "EIGHTH" },
      { capacity: 16, studyPeriod: "FIRST" }
    ]);
  });
});

function reservation(input: {
  readonly date: string;
  readonly status: string;
  readonly studyPeriod: string;
  readonly user: typeof studentA;
}) {
  return input;
}

function setting(input: { readonly capacity: number; readonly date: string; readonly studyPeriod: string }) {
  return input;
}
