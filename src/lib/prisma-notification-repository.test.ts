import { beforeEach, describe, expect, it } from "vitest";

import { delivery, periodSetting, prismaMocks } from "./prisma-notification-repository-test-utils";
import { GLOBAL_PERIOD_SETTINGS_DATE } from "./period-setting-values";
import {
  getClosedPeriodNotificationBacklogSummary,
  getClosedPeriodNotificationReconciliationBacklog,
  getDueClosedPeriodNotificationCandidates,
  prismaClosedPeriodNotificationRepository
} from "./prisma-notification-repository";

beforeEach(() => {
  prismaMocks.reset();
});

describe("Prisma closed-period notification periods", () => {
  it("resolves a missing period setting from defaults without writing a row", async () => {
    const period = await prismaClosedPeriodNotificationRepository.getPeriod({
      date: "2026-06-12",
      studyPeriod: "EIGHTH"
    });

    expect(period).toEqual({
      capacity: 10,
      closeTime: "16:20",
      confirmedCount: 0,
      date: "2026-06-12",
      enabled: true,
      openTime: "13:00",
      studyPeriod: "EIGHTH"
    });
    expect(prismaMocks.periodSettingsStore).toHaveLength(0);
  });

  it("counts confirmed reservations without loading student identity or reasons", async () => {
    prismaMocks.reservationRows.push({ reason: "자습", user: { name: "김도윤", studentNumber: "26001" } });

    const period = await prismaClosedPeriodNotificationRepository.getPeriod({
      date: "2026-06-12",
      studyPeriod: "EIGHTH"
    });

    expect(period).toEqual({
      capacity: 10,
      closeTime: "16:20",
      confirmedCount: 1,
      date: "2026-06-12",
      enabled: true,
      openTime: "13:00",
      studyPeriod: "EIGHTH"
    });
    expect(prismaMocks.reservationCount).toHaveBeenCalledWith({
      where: { date: "2026-06-12", status: "CONFIRMED", studyPeriod: "EIGHTH" }
    });
    expect(prismaMocks.reservationFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.periodSettingsStore).toHaveLength(0);
  });

  it("resolves missing date rows from global period settings", async () => {
    prismaMocks.periodSettingsStore.push(
      periodSetting({
        capacity: 6,
        closeTime: "20:30",
        date: GLOBAL_PERIOD_SETTINGS_DATE,
        openTime: "08:00",
        studyPeriod: "EIGHTH"
      })
    );

    const period = await prismaClosedPeriodNotificationRepository.getPeriod({
      date: "2026-06-12",
      studyPeriod: "EIGHTH"
    });

    expect(period).toMatchObject({
      capacity: 6,
      closeTime: "20:30",
      date: "2026-06-12",
      openTime: "08:00",
      studyPeriod: "EIGHTH"
    });
  });

  it("returns only today default closed periods for cron candidates", async () => {
    const candidates = await getDueClosedPeriodNotificationCandidates(new Date("2026-06-12T07:25:00.000Z"));

    expect(candidateKeys(candidates)).toEqual([
      "2026-06-12:EIGHTH",
      "2026-06-12:FIRST"
    ]);
    expect(prismaMocks.periodSettingsStore).toHaveLength(0);
  });

  it("ignores historical stored settings while keeping generated defaults for today", async () => {
    prismaMocks.periodSettingsStore.push(
      periodSetting({ date: "2026-06-11", studyPeriod: "EIGHTH" }),
      periodSetting({ date: "2026-06-04", studyPeriod: "FIRST" })
    );

    const keys = candidateKeys(await getDueClosedPeriodNotificationCandidates(new Date("2026-06-12T07:25:00.000Z")));

    expect(keys).toEqual(["2026-06-12:EIGHTH", "2026-06-12:FIRST"]);
    expect(keys).not.toContain("2026-06-11:EIGHTH");
    expect(keys).toContain("2026-06-12:FIRST");
    expect(keys).not.toContain("2026-06-04:FIRST");
  });

  it("materializes prior-date gaps for review and marks stale sends unknown without retrying them", async () => {
    prismaMocks.periodSettingsStore.push(
      periodSetting({ date: "2026-06-06", studyPeriod: "EIGHTH" }),
      periodSetting({ date: "2026-06-07", studyPeriod: "FIRST" }),
      periodSetting({ date: "2026-06-08", studyPeriod: "EIGHTH" }),
      periodSetting({ date: "2026-06-09", studyPeriod: "FIRST" }),
      periodSetting({ date: "2026-06-12", studyPeriod: "EIGHTH" })
    );
    prismaMocks.notificationDeliveriesStore.push(
      delivery({ date: "2026-06-06", status: "SENT", studyPeriod: "EIGHTH", updatedAt: new Date("2026-06-06T07:22:00.000Z") }),
      delivery({ date: "2026-06-07", status: "FAILED", studyPeriod: "FIRST", updatedAt: new Date("2026-06-07T07:22:00.000Z") }),
      delivery({ date: "2026-06-08", status: "SENDING", studyPeriod: "EIGHTH", updatedAt: new Date("2026-06-12T07:10:00.000Z") }),
      delivery({ date: "2026-06-09", status: "SENDING", studyPeriod: "FIRST", updatedAt: new Date("2026-06-12T07:24:00.000Z") }),
      delivery({ date: "2026-06-12", status: "FAILED", studyPeriod: "EIGHTH", updatedAt: new Date("2026-06-12T07:22:00.000Z") })
    );

    const keys = candidateKeys(await getDueClosedPeriodNotificationCandidates(new Date("2026-06-12T07:25:00.000Z")));

    expect(keys).toEqual(["2026-06-12:EIGHTH", "2026-06-12:FIRST"]);
    expect(keys).not.toContain("2026-06-07:FIRST");
    expect(keys).not.toContain("2026-06-08:EIGHTH");
    expect(keys).not.toContain("2026-06-06:EIGHTH");
    expect(keys).not.toContain("2026-06-09:FIRST");
    expect(
      prismaMocks.notificationDeliveriesStore.find(
        (row) => row.date === "2026-06-08" && row.studyPeriod === "EIGHTH"
      )?.status
    ).toBe("UNKNOWN");
    expect(
      prismaMocks.notificationDeliveriesStore.find(
        (row) => row.date === "2026-06-06" && row.studyPeriod === "FIRST"
      )?.status
    ).toBe("PENDING_REVIEW");
    expect(prismaMocks.periodSettingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.any(Array) })
      })
    );
  });

  it("suppresses a generated default when a disabled stored setting exists", async () => {
    prismaMocks.periodSettingsStore.push(periodSetting({ date: "2026-06-12", enabled: false, studyPeriod: "EIGHTH" }));

    const todayKeys = candidateKeys(await getDueClosedPeriodNotificationCandidates(new Date("2026-06-12T07:25:00.000Z")))
      .filter((key) => key.startsWith("2026-06-12:"));

    expect(todayKeys).toEqual(["2026-06-12:FIRST"]);
  });

  it("uses global period settings when choosing due cron candidates", async () => {
    prismaMocks.periodSettingsStore.push(
      periodSetting({
        closeTime: "23:59",
        date: GLOBAL_PERIOD_SETTINGS_DATE,
        openTime: "00:00",
        studyPeriod: "EIGHTH"
      })
    );

    const todayKeys = candidateKeys(await getDueClosedPeriodNotificationCandidates(new Date("2026-06-12T07:25:00.000Z")))
      .filter((key) => key.startsWith("2026-06-12:"));

    expect(todayKeys).toEqual(["2026-06-12:FIRST"]);
  });

  it("reports a bounded unresolved backlog without terminal deliveries", async () => {
    prismaMocks.notificationDeliveriesStore.push(
      delivery({ date: "2026-06-10", status: "PENDING_REVIEW", studyPeriod: "EIGHTH", updatedAt: new Date("2026-06-10T07:25:00.000Z") }),
      delivery({ date: "2026-06-11", status: "UNKNOWN", studyPeriod: "FIRST", updatedAt: new Date("2026-06-11T07:25:00.000Z") }),
      delivery({ date: "2026-06-12", status: "SENT", studyPeriod: "EIGHTH", updatedAt: new Date("2026-06-12T07:25:00.000Z") })
    );

    await expect(
      getClosedPeriodNotificationBacklogSummary(new Date("2026-06-12T07:25:00.000Z"))
    ).resolves.toEqual({ count: 2, oldestAt: new Date("2026-06-10T07:25:00.000Z") });
  });

  it("returns only actionable reconciliation rows from the bounded lookback", async () => {
    prismaMocks.notificationDeliveriesStore.push(
      delivery({
        date: "2026-06-05",
        status: "UNKNOWN",
        studyPeriod: "EIGHTH",
        updatedAt: new Date("2026-06-05T07:25:00.000Z")
      }),
      delivery({
        date: "2026-06-10",
        status: "UNKNOWN",
        studyPeriod: "FIRST",
        updatedAt: new Date("2026-06-10T07:25:00.000Z")
      }),
      delivery({
        date: "2026-06-09",
        status: "FAILED",
        studyPeriod: "EIGHTH",
        updatedAt: new Date("2026-06-09T07:25:00.000Z")
      }),
      delivery({
        date: "2026-06-11",
        status: "SENT",
        studyPeriod: "FIRST",
        updatedAt: new Date("2026-06-11T07:25:00.000Z")
      })
    );

    await expect(
      getClosedPeriodNotificationReconciliationBacklog(new Date("2026-06-12T07:25:00.000Z"))
    ).resolves.toEqual([
      expect.objectContaining({
        date: "2026-06-09",
        status: "FAILED",
        studyPeriod: "EIGHTH"
      }),
      expect.objectContaining({
        date: "2026-06-10",
        status: "UNKNOWN",
        studyPeriod: "FIRST"
      })
    ]);
  });
});

function candidateKeys(candidates: Awaited<ReturnType<typeof getDueClosedPeriodNotificationCandidates>>): readonly string[] {
  return candidates.map((candidate) => `${candidate.date}:${candidate.studyPeriod}`);
}
