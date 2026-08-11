import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StudyPeriod } from "./study-periods";

type ReservationRow = {
  readonly date: string;
  readonly id: string;
  readonly reason: string | null;
  readonly status: "CANCELLED" | "CONFIRMED" | "NO_SHOW";
  readonly studyPeriod: StudyPeriod;
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly studentNumber: string;
  };
  readonly userId: string;
};

type PeriodSettingRow = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly date: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: StudyPeriod;
};

type ReservationFindUnique = (input: {
  readonly select: unknown;
  readonly where: { readonly id: string };
}) => Promise<ReservationRow | null>;

type ReservationCount = (input: {
  readonly where: {
    readonly date: string;
    readonly status: "CONFIRMED";
    readonly studyPeriod: StudyPeriod;
  };
}) => Promise<number>;

type PeriodSettingFindMany = (input: {
  readonly where: {
    readonly date: { readonly in: readonly string[] };
    readonly studyPeriod: StudyPeriod;
  };
}) => Promise<readonly PeriodSettingRow[]>;

type SnapshotTransaction = {
  readonly periodSetting: { readonly findMany: PeriodSettingFindMany };
  readonly reservation: {
    readonly count: ReservationCount;
    readonly findUnique: ReservationFindUnique;
  };
};

type DatabaseContextInput = {
  readonly actor: { readonly id: string | null; readonly role: "SYSTEM" };
  readonly client: unknown;
  readonly operation: (transaction: SnapshotTransaction) => Promise<unknown>;
};

const mocks = vi.hoisted(() => {
  const reservationFindUnique = vi.fn<ReservationFindUnique>();
  const reservationCount = vi.fn<ReservationCount>();
  const periodSettingFindMany = vi.fn<PeriodSettingFindMany>();
  const transaction = {
    periodSetting: { findMany: periodSettingFindMany },
    reservation: { count: reservationCount, findUnique: reservationFindUnique }
  } satisfies SnapshotTransaction;
  const withDatabaseContext = vi.fn<(input: DatabaseContextInput) => Promise<unknown>>();

  return { periodSettingFindMany, reservationCount, reservationFindUnique, transaction, withDatabaseContext };
});

vi.mock("./db", () => ({ prisma: { id: "prisma-client" } }));
vi.mock("./db-context", () => ({
  systemDatabaseActor: () => ({ id: null, role: "SYSTEM" }),
  withDatabaseContext: mocks.withDatabaseContext
}));

import {
  loadDiscordReservationSnapshot
} from "./discord-reservation-snapshot";
import { GLOBAL_PERIOD_SETTINGS_DATE } from "./period-setting-values";

beforeEach(() => {
  mocks.reservationFindUnique.mockReset();
  mocks.reservationCount.mockReset();
  mocks.periodSettingFindMany.mockReset();
  mocks.withDatabaseContext.mockReset();
  mocks.withDatabaseContext.mockImplementation(async ({ operation }) => operation(mocks.transaction));
  mocks.reservationFindUnique.mockResolvedValue(reservation());
  mocks.reservationCount.mockResolvedValue(0);
  mocks.periodSettingFindMany.mockResolvedValue([]);
});

describe("Discord reservation notification snapshots", () => {
  it("returns a ready snapshot from the exact-date setting in system context", async () => {
    mocks.periodSettingFindMany.mockResolvedValue([
      setting({ capacity: 7, closeTime: "20:10", date: GLOBAL_PERIOD_SETTINGS_DATE, openTime: "12:30" }),
      setting({ capacity: 10, closeTime: "15:50", date: "2026-06-17", enabled: false, openTime: "09:00" })
    ]);
    mocks.reservationCount.mockResolvedValue(9);

    const result = await loadDiscordReservationSnapshot("reservation-1");

    expect(result).toEqual({
      kind: "ready",
      snapshot: {
        capacity: 10,
        closeAtUnix: 1_781_679_000,
        confirmedCount: 9,
        effectiveSetting: {
          capacity: 10,
          closeTime: "15:50",
          date: "2026-06-17",
          enabled: false,
          openTime: "09:00",
          studyPeriod: "EIGHTH"
        },
        remaining: 1,
        reservation: reservation()
      }
    });
    expect(mocks.withDatabaseContext).toHaveBeenCalledWith({
      actor: { id: null, role: "SYSTEM" },
      client: { id: "prisma-client" },
      operation: expect.any(Function)
    });
    expect(mocks.periodSettingFindMany).toHaveBeenCalledWith({
      where: { date: { in: ["2026-06-17", GLOBAL_PERIOD_SETTINGS_DATE] }, studyPeriod: "EIGHTH" }
    });
    expect(mocks.reservationCount).toHaveBeenCalledWith({
      where: { date: "2026-06-17", status: "CONFIRMED", studyPeriod: "EIGHTH" }
    });
  });

  it("uses a global setting when the date-specific setting is absent", async () => {
    mocks.periodSettingFindMany.mockResolvedValue([
      setting({ capacity: 12, closeTime: "18:00", date: GLOBAL_PERIOD_SETTINGS_DATE, openTime: "11:00" })
    ]);

    const result = await loadDiscordReservationSnapshot("reservation-1");

    expect(result).toMatchObject({
      kind: "ready",
      snapshot: {
        capacity: 12,
        closeAtUnix: 1_781_686_800,
        effectiveSetting: {
          capacity: 12,
          closeTime: "18:00",
          date: "2026-06-17",
          openTime: "11:00"
        },
        remaining: 12
      }
    });
  });

  it("uses existing defaults without creating period settings", async () => {
    const result = await loadDiscordReservationSnapshot("reservation-1");

    expect(result).toMatchObject({
      kind: "ready",
      snapshot: {
        capacity: 10,
        closeAtUnix: 1_781_680_800,
        effectiveSetting: {
          capacity: 10,
          closeTime: "16:20",
          date: "2026-06-17",
          enabled: true,
          openTime: "13:00",
          studyPeriod: "EIGHTH"
        },
        remaining: 10
      }
    });
    expect(Object.keys(mocks.transaction.periodSetting)).toEqual(["findMany"]);
  });

  it("reports zero remaining when the current confirmed count reaches capacity", async () => {
    mocks.reservationCount.mockResolvedValue(10);

    const result = await loadDiscordReservationSnapshot("reservation-1");

    expect(result).toMatchObject({ kind: "ready", snapshot: { confirmedCount: 10, remaining: 0 } });
  });

  it("floors remaining at zero when confirmed reservations exceed capacity", async () => {
    mocks.reservationCount.mockResolvedValue(11);

    const result = await loadDiscordReservationSnapshot("reservation-1");

    expect(result).toMatchObject({ kind: "ready", snapshot: { confirmedCount: 11, remaining: 0 } });
  });

  it.each(["CANCELLED", "NO_SHOW"] as const)("returns stale snapshots for %s reservations", async (status) => {
    mocks.reservationFindUnique.mockResolvedValue(reservation({ status }));

    const result = await loadDiscordReservationSnapshot("reservation-1");

    expect(result).toMatchObject({
      kind: "stale",
      snapshot: { reservation: { reason: "수행평가 준비", status, user: { studentNumber: "20261234" } } }
    });
  });

  it("returns not_found without reading settings or capacity when the reservation no longer exists", async () => {
    mocks.reservationFindUnique.mockResolvedValue(null);

    const result = await loadDiscordReservationSnapshot("missing-reservation");

    expect(result).toEqual({ kind: "not_found", reservationId: "missing-reservation" });
    expect(mocks.periodSettingFindMany).not.toHaveBeenCalled();
    expect(mocks.reservationCount).not.toHaveBeenCalled();
  });
});

function reservation(input: Partial<ReservationRow> = {}): ReservationRow {
  return {
    date: "2026-06-17",
    id: "reservation-1",
    reason: "수행평가 준비",
    status: "CONFIRMED",
    studyPeriod: "EIGHTH",
    user: { id: "user-1", name: "김학생", studentNumber: "20261234" },
    userId: "user-1",
    ...input
  };
}

function setting(input: {
  readonly capacity: number;
  readonly closeTime: string;
  readonly date: string;
  readonly enabled?: boolean;
  readonly openTime: string;
  readonly studyPeriod?: StudyPeriod;
}): PeriodSettingRow {
  return {
    capacity: input.capacity,
    closeTime: input.closeTime,
    date: input.date,
    enabled: input.enabled ?? true,
    openTime: input.openTime,
    studyPeriod: input.studyPeriod ?? "EIGHTH"
  };
}
