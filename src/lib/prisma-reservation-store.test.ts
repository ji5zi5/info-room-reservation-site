import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StudyPeriod } from "./study-periods";

type PeriodSettingFindManyInput = {
  readonly where: {
    readonly date: { readonly in: readonly string[] };
    readonly studyPeriod: StudyPeriod;
  };
};

type PeriodSettingUpsertInput = {
  readonly create: unknown;
  readonly update: unknown;
  readonly where: {
    readonly date_studyPeriod: {
      readonly date: string;
      readonly studyPeriod: StudyPeriod;
    };
  };
};

type UserFindUniqueInput = {
  readonly where: {
    readonly id: string;
  };
};

type ReservationFindInput = {
  readonly where: {
    readonly date: string;
    readonly status: "CONFIRMED";
    readonly studyPeriod: StudyPeriod;
    readonly userId: string;
  };
};

type ReservationCountInput = {
  readonly where: {
    readonly date: string;
    readonly status: "CONFIRMED";
    readonly studyPeriod: StudyPeriod;
  };
};

type ReservationCreateInput = {
  readonly data: {
    readonly date: string;
    readonly reason: string;
    readonly status: "CONFIRMED";
    readonly studyPeriod: StudyPeriod;
    readonly userId: string;
  };
};

type UserBookingRow = {
  readonly bookingStatus: "ACTIVE" | "BANNED" | "RESTRICTED";
  readonly restrictedUntil: Date | null;
};

type ReservationRow = {
  readonly date: string;
  readonly id: string;
  readonly reason: string | null;
  readonly status: "CONFIRMED" | "CANCELLED" | "NO_SHOW";
  readonly studyPeriod: StudyPeriod;
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

type MockPrismaTransaction = {
  readonly periodSetting: {
    readonly findMany: (input: PeriodSettingFindManyInput) => Promise<readonly PeriodSettingRow[]>;
    readonly upsert: (input: PeriodSettingUpsertInput) => Promise<never>;
  };
  readonly reservation: {
    readonly count: (input: ReservationCountInput) => Promise<number>;
    readonly create: (input: ReservationCreateInput) => Promise<ReservationRow>;
    readonly findFirst: (input: ReservationFindInput) => Promise<null>;
  };
  readonly user: {
    readonly findUnique: (input: UserFindUniqueInput) => Promise<UserBookingRow | null>;
  };
};

type TransactionOptions = {
  readonly isolationLevel: Prisma.TransactionIsolationLevel;
  readonly maxWait: number;
  readonly timeout: number;
};

type PrismaTransactionMock = (
  operation: (transaction: MockPrismaTransaction) => Promise<unknown>,
  options: TransactionOptions
) => Promise<unknown>;

const prismaMocks = vi.hoisted(() => {
  const periodSettingsStore: PeriodSettingRow[] = [];
  const transactionClient = {
    periodSetting: {
      findMany: vi.fn(async (input: PeriodSettingFindManyInput): Promise<readonly PeriodSettingRow[]> =>
        periodSettingsStore.filter(
          (setting) =>
            input.where.date.in.includes(setting.date) && setting.studyPeriod === input.where.studyPeriod
        )
      ),
      upsert: vi.fn(async (_input: PeriodSettingUpsertInput): Promise<never> => {
        throw new Error("Period settings should not be precreated by the reservation store");
      })
    },
    reservation: {
      count: vi.fn(async (_input: ReservationCountInput): Promise<number> => 0),
      create: vi.fn(async ({ data }: ReservationCreateInput): Promise<ReservationRow> => ({ id: "reservation-1", ...data })),
      findFirst: vi.fn(async (_input: ReservationFindInput): Promise<null> => null)
    },
    user: {
      findUnique: vi.fn(
        async (_input: UserFindUniqueInput): Promise<UserBookingRow> => ({
          bookingStatus: "ACTIVE",
          restrictedUntil: null
        })
      )
    }
  } satisfies MockPrismaTransaction;

  return {
    periodSettingsStore,
    transaction: vi.fn<PrismaTransactionMock>(async (operation) => operation(transactionClient)),
    transactionClient
  };
});

vi.mock("./db", () => ({
  prisma: {
    $transaction: prismaMocks.transaction
  }
}));

import {
  isSerializableTransactionConflict,
  PRISMA_RESERVATION_TRANSACTION_OPTIONS,
  prismaReservationStore,
  retrySerializableReservationTransaction
} from "./prisma-reservation-store";
import { GLOBAL_PERIOD_SETTINGS_DATE } from "./period-setting-values";
import { reserveStudyPeriod } from "./reservation-service";

beforeEach(() => {
  prismaMocks.periodSettingsStore.length = 0;
  prismaMocks.transaction.mockClear();
  prismaMocks.transactionClient.periodSetting.findMany.mockClear();
  prismaMocks.transactionClient.periodSetting.upsert.mockClear();
  prismaMocks.transactionClient.reservation.count.mockClear();
  prismaMocks.transactionClient.reservation.create.mockClear();
  prismaMocks.transactionClient.reservation.findFirst.mockClear();
  prismaMocks.transactionClient.user.findUnique.mockClear();
});

describe("Prisma reservation store transaction safety", () => {
  it("uses serializable isolation for capacity checks and reservation inserts", () => {
    expect(PRISMA_RESERVATION_TRANSACTION_OPTIONS).toMatchObject({
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 10_000
    });
  });

  it("retries serializable transaction conflicts before returning the result", async () => {
    let attempts = 0;

    const result = await retrySerializableReservationTransaction(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw prismaConflictError("P2034");
      }
      return "confirmed";
    });

    expect(result).toBe("confirmed");
    expect(attempts).toBe(3);
  });

  it("does not retry non-transaction Prisma errors", async () => {
    let attempts = 0;

    await expect(
      retrySerializableReservationTransaction(async () => {
        attempts += 1;
        throw prismaConflictError("P2002");
      })
    ).rejects.toMatchObject({ code: "P2002" });

    expect(attempts).toBe(1);
  });

  it("identifies only Prisma serializable write conflicts", () => {
    expect(isSerializableTransactionConflict(prismaConflictError("P2034"))).toBe(true);
    expect(isSerializableTransactionConflict(prismaConflictError("P2002"))).toBe(false);
    expect(isSerializableTransactionConflict(new Error("P2034"))).toBe(false);
  });
});

describe("Prisma reservation store period defaults", () => {
  it("confirms a reservation with default period settings when the row is missing", async () => {
    const result = await reserveStudyPeriod({
      date: "2026-06-16",
      now: new Date("2026-06-16T05:00:00.000Z"),
      reason: "자습",
      store: prismaReservationStore,
      studyPeriod: "EIGHTH",
      userId: "user-1"
    });

    expect(result).toEqual({
      kind: "confirmed",
      reservation: {
        date: "2026-06-16",
        id: "reservation-1",
        reason: "자습",
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        userId: "user-1"
      }
    });
    expect(prismaMocks.transactionClient.periodSetting.findMany).toHaveBeenCalledWith({
      where: {
        date: { in: ["2026-06-16", GLOBAL_PERIOD_SETTINGS_DATE] },
        studyPeriod: "EIGHTH"
      }
    });
    expect(prismaMocks.transactionClient.periodSetting.upsert).not.toHaveBeenCalled();
    expect(prismaMocks.transactionClient.reservation.create).toHaveBeenCalledTimes(1);
    expect(prismaMocks.transactionClient.reservation.create).toHaveBeenCalledWith({
      data: {
        date: "2026-06-16",
        reason: "자습",
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        userId: "user-1"
      }
    });
  });

  it("uses global period settings when the requested date has no row", async () => {
    prismaMocks.periodSettingsStore.push({
      capacity: 10,
      closeTime: "13:00",
      date: GLOBAL_PERIOD_SETTINGS_DATE,
      enabled: true,
      openTime: "00:00",
      studyPeriod: "EIGHTH"
    });

    await expect(
      reserveStudyPeriod({
        date: "2026-06-16",
        now: new Date("2026-06-16T05:00:00.000Z"),
        reason: "자습",
        store: prismaReservationStore,
        studyPeriod: "EIGHTH",
        userId: "user-1"
      })
    ).resolves.toEqual({ kind: "error", reason: "closed" });
    expect(prismaMocks.transactionClient.reservation.create).not.toHaveBeenCalled();
  });
});

function prismaConflictError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Prisma write conflict", {
    clientVersion: "test",
    code
  });
}
