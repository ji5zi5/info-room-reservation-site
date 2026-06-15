import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StudyPeriod } from "./study-periods";

type PeriodSettingRow = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly date: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: StudyPeriod;
};

type PeriodSettingFindMany = (input: {
  readonly where: {
    readonly date: string;
  };
}) => Promise<readonly PeriodSettingRow[]>;

type PeriodSettingUpsert = (input: {
  readonly create: PeriodSettingRow;
  readonly update: Record<string, never>;
  readonly where: {
    readonly date_studyPeriod: {
      readonly date: string;
      readonly studyPeriod: StudyPeriod;
    };
  };
}) => Promise<PeriodSettingRow>;

type ReservationGroupBy = () => Promise<
  readonly {
    readonly _count: {
      readonly _all: number;
    };
    readonly studyPeriod: StudyPeriod;
  }[]
>;

const prismaMocks = vi.hoisted(() => {
  const periodSettingsStore: PeriodSettingRow[] = [];
  const periodSettingFindMany = vi.fn<PeriodSettingFindMany>(async ({ where }) =>
    periodSettingsStore.filter((setting) => setting.date === where.date)
  );
  const periodSettingUpsert = vi.fn<PeriodSettingUpsert>(async ({ create, where }) => {
    const existing = periodSettingsStore.find(
      (setting) =>
        setting.date === where.date_studyPeriod.date && setting.studyPeriod === where.date_studyPeriod.studyPeriod
    );
    if (existing) {
      return existing;
    }
    periodSettingsStore.push(create);
    return create;
  });
  const reservationGroupBy = vi.fn<ReservationGroupBy>(async () => []);

  return {
    periodSettingFindMany,
    periodSettingUpsert,
    periodSettingsStore,
    reservationGroupBy,
    reset: () => {
      periodSettingsStore.length = 0;
      periodSettingFindMany.mockClear();
      periodSettingUpsert.mockClear();
      reservationGroupBy.mockClear();
    }
  };
});

vi.mock("./db", () => ({
  prisma: {
    periodSetting: {
      findMany: prismaMocks.periodSettingFindMany,
      upsert: prismaMocks.periodSettingUpsert
    },
    reservation: {
      groupBy: prismaMocks.reservationGroupBy
    }
  }
}));

import {
  DEFAULT_PERIOD_CLOSE_TIME,
  DEFAULT_PERIOD_OPEN_TIME,
  getPeriodSummaries,
  findMyReservationId
} from "./period-settings";

beforeEach(() => {
  prismaMocks.reset();
});

describe("period summary my reservation marker", () => {
  it("returns only the current user's reservation for the matching period", () => {
    const applicants = [
      { reservationId: "other-eighth", studyPeriod: "EIGHTH", userId: "other" },
      { reservationId: "mine-first", studyPeriod: "FIRST", userId: "me" },
      { reservationId: "mine-eighth", studyPeriod: "EIGHTH", userId: "me" }
    ] as const;

    expect(findMyReservationId("EIGHTH", applicants, "me")).toBe("mine-eighth");
    expect(findMyReservationId("FIRST", applicants, "me")).toBe("mine-first");
    expect(findMyReservationId("EIGHTH", applicants, "missing")).toBeNull();
  });
});

describe("period setting defaults", () => {
  it("opens at 13:00 and closes at 16:20 by default", () => {
    expect(DEFAULT_PERIOD_OPEN_TIME).toBe("13:00");
    expect(DEFAULT_PERIOD_CLOSE_TIME).toBe("16:20");
  });
});

describe("period summaries", () => {
  it("returns default settings without creating missing period setting rows", async () => {
    const rowCountBeforeRead = prismaMocks.periodSettingsStore.length;

    const periods = await getPeriodSummaries("2026-06-14", { now: new Date("2026-06-13T23:00:00.000Z") });

    expect(periods.map((period) => period.studyPeriod)).toEqual(["EIGHTH", "FIRST"]);
    expect(
      periods.map((period) => ({
        capacity: period.capacity,
        closeTime: period.closeTime,
        enabled: period.enabled,
        openTime: period.openTime,
        remaining: period.remaining,
        windowState: period.windowState
      }))
    ).toEqual([
      {
        capacity: 10,
        closeTime: "16:20",
        enabled: true,
        openTime: "13:00",
        remaining: 10,
        windowState: "not_open_yet"
      },
      {
        capacity: 10,
        closeTime: "16:20",
        enabled: true,
        openTime: "13:00",
        remaining: 10,
        windowState: "not_open_yet"
      }
    ]);
    expect(prismaMocks.periodSettingsStore).toHaveLength(rowCountBeforeRead);
    expect(prismaMocks.periodSettingUpsert).not.toHaveBeenCalled();
  });

  it("merges stored period settings with defaults without writing missing rows", async () => {
    prismaMocks.periodSettingsStore.push({
      capacity: 4,
      closeTime: "10:00",
      date: "2026-06-14",
      enabled: false,
      openTime: "09:00",
      studyPeriod: "FIRST"
    });

    const periods = await getPeriodSummaries("2026-06-14", { now: new Date("2026-06-14T00:30:00.000Z") });

    expect(
      periods.map((period) => ({
        capacity: period.capacity,
        closeTime: period.closeTime,
        enabled: period.enabled,
        openTime: period.openTime,
        remaining: period.remaining,
        studyPeriod: period.studyPeriod,
        windowState: period.windowState
      }))
    ).toEqual([
      {
        capacity: 10,
        closeTime: "16:20",
        enabled: true,
        openTime: "13:00",
        remaining: 10,
        studyPeriod: "EIGHTH",
        windowState: "not_open_yet"
      },
      {
        capacity: 4,
        closeTime: "10:00",
        enabled: false,
        openTime: "09:00",
        remaining: 4,
        studyPeriod: "FIRST",
        windowState: "open"
      }
    ]);
    expect(prismaMocks.periodSettingsStore).toHaveLength(1);
    expect(prismaMocks.periodSettingUpsert).not.toHaveBeenCalled();
  });
});
