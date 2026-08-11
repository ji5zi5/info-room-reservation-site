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

type UserFindUniqueInput = { readonly where: { readonly id: string } };

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
type ReservationFindUniqueInput = {
  readonly where: {
    readonly userId_date_studyPeriod: {
      readonly date: string;
      readonly studyPeriod: StudyPeriod;
      readonly userId: string;
    };
  };
};
type ReservationUpdateManyInput = {
  readonly data: {
    readonly reason: string;
    readonly status: "CONFIRMED";
  };
  readonly where: {
    readonly date: string;
    readonly status: "CANCELLED";
    readonly studyPeriod: StudyPeriod;
    readonly userId: string;
  };
};

type UserBookingRow = { readonly bookingStatus: "ACTIVE" | "BANNED" | "RESTRICTED"; readonly restrictedUntil: Date | null };

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
  readonly $executeRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<number>;
  readonly periodSetting: {
    readonly findMany: (input: PeriodSettingFindManyInput) => Promise<readonly PeriodSettingRow[]>;
    readonly upsert: (input: PeriodSettingUpsertInput) => Promise<never>;
  };
  readonly reservation: {
    readonly count: (input: ReservationCountInput) => Promise<number>;
    readonly create: (input: ReservationCreateInput) => Promise<ReservationRow>;
    readonly findUnique: (input: ReservationFindUniqueInput) => Promise<ReservationRow | null>;
    readonly findUniqueOrThrow: (input: ReservationFindUniqueInput) => Promise<ReservationRow>;
    readonly updateMany: (input: ReservationUpdateManyInput) => Promise<{ readonly count: number }>;
  };
  readonly discordReservationMessage: {
    readonly create: ReturnType<typeof vi.fn>;
  };
  readonly user: {
    readonly findUnique: (input: UserFindUniqueInput) => Promise<UserBookingRow | null>;
  };
};

type TransactionOptions = { readonly isolationLevel: Prisma.TransactionIsolationLevel; readonly maxWait: number; readonly timeout: number };

type PrismaTransactionMock = (
  operation: (transaction: MockPrismaTransaction) => Promise<unknown>,
  options: TransactionOptions
) => Promise<unknown>;

const prismaMocks = vi.hoisted(() => {
  const periodSettingsStore: PeriodSettingRow[] = [];
  const rawCalls: Array<{ readonly strings: readonly string[]; readonly values: readonly unknown[] }> = [];
  const transactionClient = {
    async $executeRaw(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<number> {
      rawCalls.push({ strings: [...strings], values });
      return 1;
    },
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
      findUnique: vi.fn(async (_input: ReservationFindUniqueInput): Promise<ReservationRow | null> => null),
      findUniqueOrThrow: vi.fn(
        async ({ where }: ReservationFindUniqueInput): Promise<ReservationRow> => ({
          date: where.userId_date_studyPeriod.date,
          id: "reservation-1",
          reason: "자습",
          status: "CONFIRMED",
          studyPeriod: where.userId_date_studyPeriod.studyPeriod,
          userId: where.userId_date_studyPeriod.userId
        })
      ),
      updateMany: vi.fn(async (_input: ReservationUpdateManyInput): Promise<{ readonly count: number }> => ({ count: 1 }))
    },
    discordReservationMessage: {
      create: vi.fn(async (input: unknown) => input)
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
    rawCalls,
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
  createPrismaReservationStoreForActor,
  isSerializableTransactionConflict,
  PRISMA_RESERVATION_TRANSACTION_OPTIONS,
  prismaReservationStore,
  retrySerializableReservationTransaction
} from "./prisma-reservation-store";
import { GLOBAL_PERIOD_SETTINGS_DATE } from "./period-setting-values";
import { reserveStudyPeriod } from "./reservation-service";

beforeEach(() => {
  prismaMocks.periodSettingsStore.length = 0;
  prismaMocks.rawCalls.length = 0;
  prismaMocks.transaction.mockClear();
  prismaMocks.transactionClient.periodSetting.findMany.mockClear();
  prismaMocks.transactionClient.periodSetting.upsert.mockClear();
  prismaMocks.transactionClient.discordReservationMessage.create.mockClear();
  prismaMocks.transactionClient.reservation.count.mockClear();
  prismaMocks.transactionClient.reservation.create.mockClear();
  prismaMocks.transactionClient.reservation.findUnique.mockClear();
  prismaMocks.transactionClient.reservation.findUniqueOrThrow.mockClear();
  prismaMocks.transactionClient.reservation.updateMany.mockClear();
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

  it("retries serializable conflicts after deterministic 10ms and 25ms backoff", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const result = retrySerializableReservationTransaction(async () => {
        attempts += 1;
        if (attempts < 3) {
          throw prismaConflictError("P2034");
        }
        return "confirmed";
      });

      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(9);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(24);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1);

      await expect(result).resolves.toBe("confirmed");
      expect(attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a typed error after exactly three serializable conflicts", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const result = retrySerializableReservationTransaction(async () => {
        attempts += 1;
        throw prismaConflictError("P2034");
      });

      const capturedError = result.then(
        () => null,
        (error: unknown) => error
      );
      await vi.runAllTimersAsync();
      await expect(capturedError).resolves.toMatchObject({
        attempts: 3,
        code: "TRANSACTION_RETRY_EXHAUSTED"
      });
      expect(attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
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
  it("enqueues the ledger under system RLS context and restores the student actor in the same transaction", async () => {
    const store = createPrismaReservationStoreForActor({ id: "user-1", role: "STUDENT" });

    await reserveStudyPeriod({
      date: "2026-06-16",
      now: new Date("2026-06-16T05:00:00.000Z"),
      reason: "자습",
      store,
      studyPeriod: "EIGHTH",
      userId: "user-1"
    });

    const contextWrites = prismaMocks.rawCalls.filter((call) =>
      call.strings.join("?").includes("set_config")
    );
    expect(contextWrites.map((call) => call.values)).toEqual([
      ["app.current_user_id", "user-1"],
      ["app.current_user_role", "STUDENT"],
      ["app.current_user_id", ""],
      ["app.current_user_role", "SYSTEM"],
      ["app.current_user_id", "user-1"],
      ["app.current_user_role", "STUDENT"]
    ]);
    expect(prismaMocks.transactionClient.discordReservationMessage.create).toHaveBeenCalledTimes(1);
  });

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
    expect(prismaMocks.transactionClient.discordReservationMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        nonce: "reservation-c0b40f5293a4",
        reservationId: "reservation-1"
      })
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

  it.each(["CANCELLED", "NO_SHOW"] as const)(
    "returns duplicate without mutating an existing %s reservation identity",
    async (status) => {
      prismaMocks.transactionClient.reservation.findUnique.mockResolvedValueOnce({
        date: "2026-06-16",
        id: "reservation-historical",
        reason: "첫 예약",
        status,
        studyPeriod: "EIGHTH",
        userId: "user-1"
      });

      const result = await reserveStudyPeriod({
        date: "2026-06-16",
        now: new Date("2026-06-16T05:00:00.000Z"),
        reason: "다시 예약",
        store: prismaReservationStore,
        studyPeriod: "EIGHTH",
        userId: "user-1"
      });

      expect(result).toEqual({ kind: "error", reason: "duplicate" });
      expect(prismaMocks.transactionClient.reservation.count).not.toHaveBeenCalled();
      expect(prismaMocks.transactionClient.reservation.updateMany).not.toHaveBeenCalled();
      expect(prismaMocks.transactionClient.reservation.create).not.toHaveBeenCalled();
      const advisoryLocks = prismaMocks.rawCalls.filter((call) =>
        call.strings.join("?").includes("pg_advisory_xact_lock")
      );
      expect(advisoryLocks.map((call) => call.values)).toEqual([
        ["period:2026-06-16:EIGHTH"],
        ["user:user-1"]
      ]);
    }
  );

  it("returns duplicate when the reservation identity loses a concurrent insert race", async () => {
    prismaMocks.transactionClient.reservation.create.mockRejectedValueOnce(prismaConflictError("P2002"));

    await expect(
      reserveStudyPeriod({
        date: "2026-06-16",
        now: new Date("2026-06-16T05:00:00.000Z"),
        reason: "자습",
        store: prismaReservationStore,
        studyPeriod: "EIGHTH",
        userId: "user-1"
      })
    ).resolves.toEqual({ kind: "error", reason: "duplicate" });
  });
});

function prismaConflictError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Prisma write conflict", {
    clientVersion: "test",
    code
  });
}
