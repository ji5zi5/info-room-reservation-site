import { beforeEach, describe, expect, it } from "vitest";

import { delivery, periodSetting, prismaMocks } from "./prisma-notification-repository-test-utils";
import {
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
      applicants: [],
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

  it("includes confirmed reservations when resolving defaults", async () => {
    prismaMocks.reservationRows.push({ user: { name: "김도윤", studentNumber: "26001" } });

    const period = await prismaClosedPeriodNotificationRepository.getPeriod({
      date: "2026-06-12",
      studyPeriod: "EIGHTH"
    });

    expect(period?.confirmedCount).toBe(1);
    expect(period?.applicants).toEqual([{ name: "김도윤", studentNumber: "26001" }]);
    expect(prismaMocks.periodSettingsStore).toHaveLength(0);
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

  it("does not retry failed or stale deliveries from prior dates in the cron candidate query", async () => {
    prismaMocks.periodSettingsStore.push(
      periodSetting({ date: "2026-01-02", studyPeriod: "EIGHTH" }),
      periodSetting({ date: "2026-01-03", studyPeriod: "FIRST" }),
      periodSetting({ date: "2026-01-04", studyPeriod: "EIGHTH" }),
      periodSetting({ date: "2026-01-05", studyPeriod: "FIRST" }),
      periodSetting({ date: "2026-06-12", studyPeriod: "EIGHTH" })
    );
    prismaMocks.notificationDeliveriesStore.push(
      delivery({ date: "2026-01-02", status: "SENT", studyPeriod: "EIGHTH", updatedAt: new Date("2026-01-02T07:22:00.000Z") }),
      delivery({ date: "2026-01-03", status: "FAILED", studyPeriod: "FIRST", updatedAt: new Date("2026-01-03T07:22:00.000Z") }),
      delivery({ date: "2026-01-04", status: "SENDING", studyPeriod: "EIGHTH", updatedAt: new Date("2026-06-12T07:10:00.000Z") }),
      delivery({ date: "2026-01-05", status: "SENDING", studyPeriod: "FIRST", updatedAt: new Date("2026-06-12T07:24:00.000Z") }),
      delivery({ date: "2026-06-12", status: "FAILED", studyPeriod: "EIGHTH", updatedAt: new Date("2026-06-12T07:22:00.000Z") })
    );

    const keys = candidateKeys(await getDueClosedPeriodNotificationCandidates(new Date("2026-06-12T07:25:00.000Z")));

    expect(keys).toEqual(["2026-06-12:EIGHTH", "2026-06-12:FIRST"]);
    expect(keys).not.toContain("2026-01-03:FIRST");
    expect(keys).not.toContain("2026-01-04:EIGHTH");
    expect(keys).not.toContain("2026-01-02:EIGHTH");
    expect(keys).not.toContain("2026-01-05:FIRST");
    expect(
      prismaMocks.periodSettingFindMany.mock.calls.some(
        ([input]) => typeof input.where?.date === "object" && "lte" in input.where.date && !("gte" in input.where.date)
      )
    ).toBe(false);
  });

  it("suppresses a generated default when a disabled stored setting exists", async () => {
    prismaMocks.periodSettingsStore.push(periodSetting({ date: "2026-06-12", enabled: false, studyPeriod: "EIGHTH" }));

    const todayKeys = candidateKeys(await getDueClosedPeriodNotificationCandidates(new Date("2026-06-12T07:25:00.000Z")))
      .filter((key) => key.startsWith("2026-06-12:"));

    expect(todayKeys).toEqual(["2026-06-12:FIRST"]);
  });
});

function candidateKeys(candidates: Awaited<ReturnType<typeof getDueClosedPeriodNotificationCandidates>>): readonly string[] {
  return candidates.map((candidate) => `${candidate.date}:${candidate.studyPeriod}`);
}
