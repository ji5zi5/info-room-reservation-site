import { describe, expect, it } from "vitest";

import { getMockAdminDashboard, getMockAdminStatistics } from "./mock-admin-data";

describe("mock admin data", () => {
  it("returns dashboard periods without database rows", () => {
    const periods = getMockAdminDashboard("2026-06-14", new Date("2026-06-13T23:00:00.000Z"));

    expect(periods.map((period) => period.studyPeriod)).toEqual(["EIGHTH", "FIRST"]);
    expect(
      periods.map((period) => ({
        applicants: period.applicants,
        capacity: period.capacity,
        isClosed: period.isClosed,
        notification: period.notification,
        windowState: period.windowState
      }))
    ).toEqual([
      {
        applicants: [],
        capacity: 10,
        isClosed: false,
        notification: null,
        windowState: "not_open_yet"
      },
      {
        applicants: [],
        capacity: 10,
        isClosed: false,
        notification: null,
        windowState: "not_open_yet"
      }
    ]);
  });

  it("returns zeroed statistics for the requested date range", () => {
    const statistics = getMockAdminStatistics({ from: "2026-06-14", to: "2026-06-14" });

    expect(statistics).toEqual({
      dailyStats: [
        {
          cancelledCount: 0,
          confirmedCount: 0,
          date: "2026-06-14",
          noShowCount: 0,
          totalCount: 0
        }
      ],
      from: "2026-06-14",
      periodStats: [
        {
          cancelledCount: 0,
          capacity: 10,
          confirmedCount: 0,
          fillRate: 0,
          label: "8면학",
          noShowCount: 0,
          studyPeriod: "EIGHTH",
          totalCount: 0
        },
        {
          cancelledCount: 0,
          capacity: 10,
          confirmedCount: 0,
          fillRate: 0,
          label: "1면학",
          noShowCount: 0,
          studyPeriod: "FIRST",
          totalCount: 0
        }
      ],
      repeatedOffenders: [],
      to: "2026-06-14",
      totals: {
        cancelledCount: 0,
        confirmedCount: 0,
        noShowCount: 0,
        totalCount: 0,
        uniqueStudentCount: 0
      }
    });
  });
});
