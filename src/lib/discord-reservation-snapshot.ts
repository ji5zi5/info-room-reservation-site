import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";
import { toKstDate } from "./date";
import { periodSettingReadDates, resolveEffectivePeriodSetting, type PeriodSettingDefaults } from "./period-setting-values";
import { parseStudyPeriod, type StudyPeriod } from "./study-periods";

type ReservationSnapshotStatus = "CANCELLED" | "CONFIRMED" | "NO_SHOW";

type ReservationSnapshotRow = {
  readonly date: string;
  readonly id: string;
  readonly reason: string | null;
  readonly status: string;
  readonly studyPeriod: string;
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly studentNumber: string;
  };
  readonly userId: string;
};

type PeriodSettingSnapshotRow = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly date: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: string;
};

export type DiscordReservationSnapshotTransaction = {
  readonly periodSetting: {
    readonly findMany: (input: {
      readonly where: {
        readonly date: { readonly in: readonly string[] };
        readonly studyPeriod: StudyPeriod;
      };
    }) => Promise<readonly PeriodSettingSnapshotRow[]>;
  };
  readonly reservation: {
    readonly count: (input: {
      readonly where: {
        readonly date: string;
        readonly status: "CONFIRMED";
        readonly studyPeriod: StudyPeriod;
      };
    }) => Promise<number>;
    readonly findUnique: (input: {
      readonly select: {
        readonly date: true;
        readonly id: true;
        readonly reason: true;
        readonly status: true;
        readonly studyPeriod: true;
        readonly user: { readonly select: { readonly id: true; readonly name: true; readonly studentNumber: true } };
        readonly userId: true;
      };
      readonly where: { readonly id: string };
    }) => Promise<ReservationSnapshotRow | null>;
  };
};

export type DiscordReservationSnapshot = {
  readonly capacity: number;
  readonly closeAtUnix: number;
  readonly confirmedCount: number;
  readonly effectiveSetting: PeriodSettingDefaults;
  readonly remaining: number;
  readonly reservation: {
    readonly date: string;
    readonly id: string;
    readonly reason: string | null;
    readonly status: ReservationSnapshotStatus;
    readonly studyPeriod: StudyPeriod;
    readonly user: {
      readonly id: string;
      readonly name: string;
      readonly studentNumber: string;
    };
    readonly userId: string;
  };
};

export type DiscordReservationSnapshotResult =
  | { readonly kind: "not_found"; readonly reservationId: string }
  | { readonly kind: "ready"; readonly snapshot: DiscordReservationSnapshot }
  | { readonly kind: "stale"; readonly snapshot: DiscordReservationSnapshot };

export type DiscordReservationSnapshotQueryExecutor = (
  operation: (transaction: DiscordReservationSnapshotTransaction) => Promise<DiscordReservationSnapshotResult>
) => Promise<DiscordReservationSnapshotResult>;

const RESERVATION_SNAPSHOT_SELECT = {
  date: true,
  id: true,
  reason: true,
  status: true,
  studyPeriod: true,
  user: { select: { id: true, name: true, studentNumber: true } },
  userId: true
} as const;

export function createDiscordReservationSnapshotLoader(
  executeQuery: DiscordReservationSnapshotQueryExecutor
): (reservationId: string) => Promise<DiscordReservationSnapshotResult> {
  return async (reservationId) =>
    executeQuery(async (transaction) => {
      const reservation = await transaction.reservation.findUnique({
        select: RESERVATION_SNAPSHOT_SELECT,
        where: { id: reservationId }
      });

      if (!reservation) {
        return { kind: "not_found", reservationId };
      }

      const studyPeriod = parseStudyPeriod(reservation.studyPeriod);
      const [settings, confirmedCount] = await Promise.all([
        transaction.periodSetting.findMany({
          where: {
            date: { in: [...periodSettingReadDates(reservation.date)] },
            studyPeriod
          }
        }),
        transaction.reservation.count({
          where: { date: reservation.date, status: "CONFIRMED", studyPeriod }
        })
      ]);
      const effectiveSetting = resolveEffectivePeriodSetting(reservation.date, studyPeriod, settings);
      const snapshot = {
        capacity: effectiveSetting.capacity,
        closeAtUnix: kstCloseUnixTimestamp(reservation.date, effectiveSetting.closeTime),
        confirmedCount,
        effectiveSetting,
        remaining: Math.max(effectiveSetting.capacity - confirmedCount, 0),
        reservation: {
          ...reservation,
          status: parseReservationSnapshotStatus(reservation.status),
          studyPeriod
        }
      } satisfies DiscordReservationSnapshot;

      switch (snapshot.reservation.status) {
        case "CONFIRMED":
          return { kind: "ready", snapshot };
        case "CANCELLED":
        case "NO_SHOW":
          return { kind: "stale", snapshot };
      }
    });
}

export const loadDiscordReservationSnapshot = createDiscordReservationSnapshotLoader((operation) =>
  withDatabaseContext({
    actor: systemDatabaseActor(),
    client: prisma,
    operation: (transaction) =>
      operation({
        periodSetting: {
          findMany: ({ where }) =>
            transaction.periodSetting.findMany({
              where: { date: { in: [...where.date.in] }, studyPeriod: where.studyPeriod }
            })
        },
        reservation: {
          count: ({ where }) => transaction.reservation.count({ where }),
          findUnique: ({ where }) => transaction.reservation.findUnique({ select: RESERVATION_SNAPSHOT_SELECT, where })
        }
      })
  })
);

function kstCloseUnixTimestamp(date: string, closeTime: string): number {
  const closeAt = new Date(`${date}T${closeTime}:00+09:00`);
  if (toKstDate(closeAt) !== date) {
    throw new InvalidKstCloseTimestampError(date, closeTime);
  }
  return Math.floor(closeAt.getTime() / 1_000);
}

function parseReservationSnapshotStatus(status: string): ReservationSnapshotStatus {
  switch (status) {
    case "CANCELLED":
    case "CONFIRMED":
    case "NO_SHOW":
      return status;
    default:
      throw new InvalidReservationSnapshotStatusError(status);
  }
}

class InvalidKstCloseTimestampError extends Error {
  public constructor(date: string, closeTime: string) {
    super(`Invalid KST close timestamp: ${date} ${closeTime}`);
    this.name = "InvalidKstCloseTimestampError";
  }
}

class InvalidReservationSnapshotStatusError extends Error {
  public constructor(status: string) {
    super(`Invalid reservation snapshot status: ${status}`);
    this.name = "InvalidReservationSnapshotStatusError";
  }
}
