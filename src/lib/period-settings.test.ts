import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseActor } from "./db-context";
import type { StudyPeriod } from "./study-periods";

type PeriodSettingRow = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly date: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: StudyPeriod;
};

type PeriodSettingDateFilter = string | { readonly in: readonly string[] };

type PeriodSettingFindMany = (input: {
  readonly where: {
    readonly date: PeriodSettingDateFilter;
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

type ReservationGroupByRow = {
  readonly _count: { readonly _all: number };
  readonly date?: string;
  readonly studyPeriod: StudyPeriod;
};
type ReservationGroupBy = (input?: unknown) => Promise<readonly ReservationGroupByRow[]>;
type ReservationApplicantRow = {
  readonly id: string;
  readonly studyPeriod: StudyPeriod;
  readonly user: { readonly name: string; readonly studentNumber: string };
  readonly userId: string;
};

type ReservationOwnerRow = Omit<ReservationApplicantRow, "user"> & { readonly date?: string };
type ReservationFindMany = (input: unknown) => Promise<readonly (ReservationApplicantRow | ReservationOwnerRow)[]>;

type PeriodWeekReader = (
  weekStart: string,
  options: { readonly actor: DatabaseActor; readonly currentUserId: string }
) => Promise<{
  readonly dates: readonly {
    readonly date: string;
    readonly periods: readonly {
      readonly availability: number;
      readonly capacity: number;
      readonly closeTime: string;
      readonly enabled: boolean;
      readonly myReservationId: string | null;
      readonly openTime: string;
      readonly reservedCount: number;
      readonly studyPeriod: StudyPeriod;
    }[];
  }[];
}>;

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });

  return { promise, resolve: resolveDeferred };
}

const prismaMocks = vi.hoisted(() => {
  const periodSettingsStore: PeriodSettingRow[] = [];
  const matchesDateFilter = (date: string, filter: PeriodSettingDateFilter): boolean =>
    typeof filter === "string" ? date === filter : filter.in.includes(date);
  const periodSettingFindMany = vi.fn<PeriodSettingFindMany>(async ({ where }) =>
    periodSettingsStore.filter((setting) => matchesDateFilter(setting.date, where.date))
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
  const reservationFindMany = vi.fn<ReservationFindMany>(async () => []);
  const rawPeriodSettingFindMany = vi.fn<PeriodSettingFindMany>(async () => []);
  const rawPeriodSettingUpsert = vi.fn<PeriodSettingUpsert>();
  const rawReservationFindMany = vi.fn<ReservationFindMany>(async () => []);
  const rawReservationGroupBy = vi.fn<ReservationGroupBy>(async () => []);

  return {
    periodSettingFindMany,
    periodSettingUpsert,
    periodSettingsStore,
    reservationFindMany,
    reservationGroupBy,
    rawPeriodSettingFindMany,
    rawPeriodSettingUpsert,
    rawReservationFindMany,
    rawReservationGroupBy,
    reset: () => {
      periodSettingsStore.length = 0;
      periodSettingFindMany.mockClear();
      periodSettingUpsert.mockClear();
      reservationFindMany.mockClear();
      reservationGroupBy.mockClear();
      rawPeriodSettingFindMany.mockClear();
      rawPeriodSettingUpsert.mockClear();
      rawReservationFindMany.mockClear();
      rawReservationGroupBy.mockClear();
    }
  };
});

vi.mock("./db", () => ({
  prisma: {
    periodSetting: {
      findMany: prismaMocks.rawPeriodSettingFindMany,
      upsert: prismaMocks.rawPeriodSettingUpsert
    },
    reservation: {
      findMany: prismaMocks.rawReservationFindMany,
      groupBy: prismaMocks.rawReservationGroupBy
    }
  }
}));

const contextMocks = vi.hoisted(() => ({
  withDatabaseContext: vi.fn()
}));

vi.mock("./db-context", () => ({
  withDatabaseContext: contextMocks.withDatabaseContext
}));

import {
  DEFAULT_PERIOD_CLOSE_TIME,
  DEFAULT_PERIOD_OPEN_TIME,
  GLOBAL_PERIOD_SETTINGS_DATE,
  ensurePeriodSettings,
  getPeriodSummaries,
  findMyReservationId
} from "./period-settings";

beforeEach(() => {
  prismaMocks.reset();
  contextMocks.withDatabaseContext.mockReset();
  contextMocks.withDatabaseContext.mockImplementation(async (input) =>
    input.operation({
      periodSetting: {
        findMany: prismaMocks.periodSettingFindMany,
        upsert: prismaMocks.periodSettingUpsert
      },
      reservation: {
        findMany: prismaMocks.reservationFindMany,
        groupBy: prismaMocks.reservationGroupBy
      }
    })
  );
});

const systemActor = { id: null, role: "SYSTEM" } satisfies DatabaseActor;

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
  it("reads a canonical five-day student week in exactly three privacy-safe queries", async () => {
    prismaMocks.periodSettingsStore.push(
      {
        capacity: 6,
        closeTime: "16:20",
        date: GLOBAL_PERIOD_SETTINGS_DATE,
        enabled: true,
        openTime: "13:00",
        studyPeriod: "EIGHTH"
      },
      {
        capacity: 3,
        closeTime: "15:50",
        date: "2026-07-21",
        enabled: false,
        openTime: "12:40",
        studyPeriod: "FIRST"
      }
    );
    prismaMocks.reservationGroupBy.mockResolvedValueOnce([
      { _count: { _all: 2 }, date: "2026-07-20", studyPeriod: "FIRST" },
      { _count: { _all: 4 }, date: "2026-07-21", studyPeriod: "EIGHTH" }
    ]);
    prismaMocks.reservationFindMany.mockResolvedValueOnce([
      { date: "2026-07-21", id: "mine-eighth", studyPeriod: "EIGHTH", userId: "me" }
    ]);
    const periodSettingsModule = await import("./period-settings");
    const getPeriodWeekSummaries = (
      periodSettingsModule as typeof periodSettingsModule & {
        readonly getPeriodWeekSummaries?: PeriodWeekReader;
      }
    ).getPeriodWeekSummaries;

    expect(getPeriodWeekSummaries).toBeTypeOf("function");
    if (!getPeriodWeekSummaries) {
      return;
    }

    const week = await getPeriodWeekSummaries("2026-07-20", {
      actor: systemActor,
      currentUserId: "me"
    });

    expect(contextMocks.withDatabaseContext).toHaveBeenCalledWith({
      actor: systemActor,
      client: expect.any(Object),
      operation: expect.any(Function)
    });
    expect(prismaMocks.rawPeriodSettingFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.rawReservationGroupBy).not.toHaveBeenCalled();
    expect(prismaMocks.rawReservationFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.periodSettingFindMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.reservationGroupBy).toHaveBeenCalledTimes(1);
    expect(prismaMocks.reservationFindMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.periodSettingFindMany).toHaveBeenCalledWith({
      where: {
        date: {
          in: [
            GLOBAL_PERIOD_SETTINGS_DATE,
            "2026-07-20",
            "2026-07-21",
            "2026-07-22",
            "2026-07-23",
            "2026-07-24"
          ]
        }
      }
    });
    expect(prismaMocks.reservationGroupBy).toHaveBeenCalledWith({
      _count: { _all: true },
      by: ["date", "studyPeriod"],
      where: {
        date: { in: ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"] },
        status: "CONFIRMED"
      }
    });
    expect(prismaMocks.reservationFindMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "asc" },
      select: { date: true, id: true, studyPeriod: true },
      where: {
        date: { in: ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"] },
        status: "CONFIRMED",
        userId: "me"
      }
    });
    expect(week.dates.map(({ date }) => date)).toEqual([
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
      "2026-07-23",
      "2026-07-24"
    ]);
    expect(week.dates.every(({ periods }) => periods.map(({ studyPeriod }) => studyPeriod).join(",") === "EIGHTH,FIRST"))
      .toBe(true);
    expect(week.dates.flatMap(({ periods }) => periods).every((period) => Object.keys(period).join(",") ===
      "studyPeriod,openTime,closeTime,capacity,reservedCount,enabled,availability,myReservationId"))
      .toBe(true);
    expect(week.dates[0]?.periods).toEqual([
      {
        availability: 6,
        capacity: 6,
        closeTime: "16:20",
        enabled: true,
        myReservationId: null,
        openTime: "13:00",
        reservedCount: 0,
        studyPeriod: "EIGHTH"
      },
      {
        availability: 8,
        capacity: 10,
        closeTime: "16:20",
        enabled: true,
        myReservationId: null,
        openTime: "13:00",
        reservedCount: 2,
        studyPeriod: "FIRST"
      }
    ]);
    expect(week.dates[1]?.periods).toEqual([
      {
        availability: 2,
        capacity: 6,
        closeTime: "16:20",
        enabled: true,
        myReservationId: "mine-eighth",
        openTime: "13:00",
        reservedCount: 4,
        studyPeriod: "EIGHTH"
      },
      {
        availability: 3,
        capacity: 3,
        closeTime: "15:50",
        enabled: false,
        myReservationId: null,
        openTime: "12:40",
        reservedCount: 0,
        studyPeriod: "FIRST"
      }
    ]);
  });

  it("queries only the current user's reservation identity when applicants are not requested", async () => {
    prismaMocks.reservationFindMany.mockResolvedValueOnce([
      { id: "mine-eighth", studyPeriod: "EIGHTH", userId: "me" }
    ]);

    try {
      const periods = await getPeriodSummaries("2026-06-14", {
        actor: systemActor,
        currentUserId: "me",
        now: new Date("2026-06-14T00:30:00.000Z")
      });

      expect(prismaMocks.reservationFindMany).toHaveBeenCalledWith({
        orderBy: { createdAt: "asc" },
        select: { id: true, studyPeriod: true, userId: true },
        where: { date: "2026-06-14", status: "CONFIRMED", userId: "me" }
      });
      expect(periods.map((period) => period.myReservationId)).toEqual(["mine-eighth", null]);
      expect(periods.every((period) => period.applicants.length === 0)).toBe(true);
    } finally {
      prismaMocks.reservationFindMany.mockReset();
      prismaMocks.reservationFindMany.mockResolvedValue([]);
    }
  });

  it("starts settings counts and applicant reads before awaiting period summary DB results", async () => {
    const settingsDeferred = createDeferred<readonly PeriodSettingRow[]>();
    const countsDeferred = createDeferred<readonly ReservationGroupByRow[]>();
    const applicantsDeferred = createDeferred<readonly ReservationApplicantRow[]>();

    prismaMocks.periodSettingFindMany.mockImplementationOnce(() => settingsDeferred.promise);
    prismaMocks.reservationGroupBy.mockImplementationOnce(() => countsDeferred.promise);
    prismaMocks.reservationFindMany.mockImplementationOnce(() => applicantsDeferred.promise);

    const summariesPromise = getPeriodSummaries("2026-06-14", {
      actor: { id: "admin-summary", role: "ADMIN" },
      currentUserId: "me",
      includeApplicants: true,
      now: new Date("2026-06-14T00:30:00.000Z")
    });

    try {
      expect(prismaMocks.periodSettingFindMany).toHaveBeenCalledTimes(1);
      expect(prismaMocks.reservationGroupBy).toHaveBeenCalledTimes(1);
      expect(prismaMocks.reservationFindMany).toHaveBeenCalledTimes(1);

      settingsDeferred.resolve([
        { capacity: 3, closeTime: "10:00", date: "2026-06-14", enabled: true, openTime: "09:00", studyPeriod: "FIRST" }
      ]);
      countsDeferred.resolve([
        { _count: { _all: 1 }, studyPeriod: "FIRST" },
        { _count: { _all: 2 }, studyPeriod: "EIGHTH" }
      ]);
      applicantsDeferred.resolve([
        { id: "mine-first", studyPeriod: "FIRST", user: { name: "Me", studentNumber: "1001" }, userId: "me" },
        { id: "other-eighth", studyPeriod: "EIGHTH", user: { name: "Other", studentNumber: "1002" }, userId: "other" },
        { id: "mine-eighth", studyPeriod: "EIGHTH", user: { name: "Me", studentNumber: "1001" }, userId: "me" }
      ]);

      const periods = await summariesPromise;

      expect(periods.map((period) => period.studyPeriod)).toEqual(["EIGHTH", "FIRST"]);
      expect(periods.map((period) => period.myReservationId)).toEqual(["mine-eighth", "mine-first"]);
      expect(periods.map((period) => period.applicants.map((applicant) => applicant.reservationId))).toEqual([
        ["other-eighth", "mine-eighth"],
        ["mine-first"]
      ]);
      expect(periods.map((period) => period.remaining)).toEqual([8, 2]);
    } finally {
      settingsDeferred.resolve([]);
      countsDeferred.resolve([]);
      applicantsDeferred.resolve([]);
    }
  });

  it("returns default settings without creating missing period setting rows", async () => {
    const rowCountBeforeRead = prismaMocks.periodSettingsStore.length;

    const periods = await getPeriodSummaries("2026-06-14", {
      actor: systemActor,
      now: new Date("2026-06-13T23:00:00.000Z")
    });

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

    const periods = await getPeriodSummaries("2026-06-14", {
      actor: systemActor,
      now: new Date("2026-06-14T00:30:00.000Z")
    });

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

  it("uses global period settings for dates without stored rows", async () => {
    prismaMocks.periodSettingsStore.push({
      capacity: 6,
      closeTime: "22:00",
      date: GLOBAL_PERIOD_SETTINGS_DATE,
      enabled: true,
      openTime: "08:00",
      studyPeriod: "EIGHTH"
    });

    const periods = await getPeriodSummaries("2026-06-17", {
      actor: systemActor,
      now: new Date("2026-06-17T00:30:00.000Z")
    });

    expect(
      periods.map((period) => ({
        capacity: period.capacity,
        closeTime: period.closeTime,
        openTime: period.openTime,
        studyPeriod: period.studyPeriod,
        windowState: period.windowState
      }))
    ).toEqual([
      {
        capacity: 6,
        closeTime: "22:00",
        openTime: "08:00",
        studyPeriod: "EIGHTH",
        windowState: "open"
      },
      {
        capacity: 10,
        closeTime: "16:20",
        openTime: "13:00",
        studyPeriod: "FIRST",
        windowState: "not_open_yet"
      }
    ]);
    expect(prismaMocks.periodSettingUpsert).not.toHaveBeenCalled();
  });

  it("lets a date-specific period setting override the global setting", async () => {
    prismaMocks.periodSettingsStore.push(
      {
        capacity: 6,
        closeTime: "22:00",
        date: GLOBAL_PERIOD_SETTINGS_DATE,
        enabled: true,
        openTime: "08:00",
        studyPeriod: "EIGHTH"
      },
      {
        capacity: 3,
        closeTime: "09:00",
        date: "2026-06-17",
        enabled: false,
        openTime: "07:00",
        studyPeriod: "EIGHTH"
      }
    );

    const [eighth] = await getPeriodSummaries("2026-06-17", {
      actor: systemActor,
      now: new Date("2026-06-17T00:30:00.000Z")
    });

    expect(eighth).toMatchObject({
      capacity: 3,
      closeTime: "09:00",
      enabled: false,
      openTime: "07:00",
      studyPeriod: "EIGHTH"
    });
  });

  it("contextualizes setting reads and writes with the exact trusted actor", async () => {
    const actor = { id: "admin-settings", role: "ADMIN" } satisfies DatabaseActor;

    await ensurePeriodSettings("2026-06-18", actor);

    expect(contextMocks.withDatabaseContext).toHaveBeenCalledWith({
      actor,
      client: expect.any(Object),
      operation: expect.any(Function)
    });
    expect(prismaMocks.periodSettingFindMany).toHaveBeenCalledOnce();
    expect(prismaMocks.periodSettingUpsert).toHaveBeenCalledTimes(2);
    expect(prismaMocks.rawPeriodSettingFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.rawPeriodSettingUpsert).not.toHaveBeenCalled();
  });
});
