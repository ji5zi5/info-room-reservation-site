import { Prisma, type Reservation as PrismaReservation } from "@prisma/client";

import {
  type PeriodSetting,
  type Reservation,
  type ReservationStore,
  type TransactionalReservationStore,
  type UserBookingState
} from "./reservation-service";
import { prisma } from "./db";
import { buildDefaultPeriodSetting, parseStoredStudyPeriod } from "./period-settings";
import type { StudyPeriod } from "./study-periods";

type PrismaTransaction = Prisma.TransactionClient;

const MAX_SERIALIZABLE_TRANSACTION_ATTEMPTS = 3;

type PrismaInteractiveTransactionOptions = {
  readonly isolationLevel: Prisma.TransactionIsolationLevel;
  readonly maxWait: number;
  readonly timeout: number;
};

export const PRISMA_RESERVATION_TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 5_000,
  timeout: 10_000
} satisfies PrismaInteractiveTransactionOptions;

export class PrismaReservationStore implements TransactionalReservationStore {
  public async transaction<T>(operation: (store: ReservationStore) => Promise<T>): Promise<T> {
    return retrySerializableReservationTransaction(() =>
      prisma.$transaction(
        async (transaction) => operation(new PrismaReservationStoreUnit(transaction)),
        PRISMA_RESERVATION_TRANSACTION_OPTIONS
      )
    );
  }
}

export const prismaReservationStore = new PrismaReservationStore();

class PrismaReservationStoreUnit implements ReservationStore {
  private readonly client: PrismaTransaction;

  public constructor(client: PrismaTransaction) {
    this.client = client;
  }

  public async countConfirmedReservations(date: string, studyPeriod: StudyPeriod): Promise<number> {
    return this.client.reservation.count({ where: { date, status: "CONFIRMED", studyPeriod } });
  }

  public async createReservation(input: {
    readonly date: string;
    readonly reason: string;
    readonly studyPeriod: StudyPeriod;
    readonly userId: string;
  }): Promise<Reservation> {
    const created = await this.client.reservation.create({
      data: {
        date: input.date,
        reason: input.reason,
        status: "CONFIRMED",
        studyPeriod: input.studyPeriod,
        userId: input.userId
      }
    });
    return toReservation(created);
  }

  public async findReservation(input: {
    readonly date: string;
    readonly studyPeriod: StudyPeriod;
    readonly userId: string;
  }): Promise<Reservation | null> {
    const reservation = await this.client.reservation.findFirst({
      where: {
        date: input.date,
        status: "CONFIRMED",
        studyPeriod: input.studyPeriod,
        userId: input.userId
      }
    });
    return reservation ? toReservation(reservation) : null;
  }

  public async getPeriodSetting(date: string, studyPeriod: StudyPeriod): Promise<PeriodSetting | null> {
    const setting = await this.client.periodSetting.findUnique({
      where: {
        date_studyPeriod: {
          date,
          studyPeriod
        }
      }
    });
    if (!setting) {
      return buildDefaultPeriodSetting(date, studyPeriod);
    }
    return {
      capacity: setting.capacity,
      closeTime: setting.closeTime,
      date: setting.date,
      enabled: setting.enabled,
      openTime: setting.openTime,
      studyPeriod: parseStoredStudyPeriod(setting.studyPeriod)
    };
  }

  public async getUserBookingState(userId: string): Promise<UserBookingState | null> {
    const user = await this.client.user.findUnique({ where: { id: userId } });
    if (!user) {
      return null;
    }
    return {
      bookingStatus: parseBookingStatus(user.bookingStatus),
      restrictedUntil: user.restrictedUntil
    };
  }
}

function toReservation(reservation: PrismaReservation): Reservation {
  return {
    date: reservation.date,
    id: reservation.id,
    reason: reservation.reason,
    status: parseReservationStatus(reservation.status),
    studyPeriod: parseStoredStudyPeriod(reservation.studyPeriod),
    userId: reservation.userId
  };
}

function parseBookingStatus(value: string): "ACTIVE" | "BANNED" | "RESTRICTED" | "SHADOW_BANNED" {
  switch (value) {
    case "ACTIVE":
      return "ACTIVE";
    case "BANNED":
      return "BANNED";
    case "RESTRICTED":
      return "RESTRICTED";
    case "SHADOW_BANNED":
      return "SHADOW_BANNED";
    default:
      throw new InvalidStoredValueError("bookingStatus", value);
  }
}

function parseReservationStatus(value: string): "CANCELLED" | "CONFIRMED" | "NO_SHOW" {
  switch (value) {
    case "CANCELLED":
      return "CANCELLED";
    case "CONFIRMED":
      return "CONFIRMED";
    case "NO_SHOW":
      return "NO_SHOW";
    default:
      throw new InvalidStoredValueError("reservationStatus", value);
  }
}

class InvalidStoredValueError extends Error {
  public constructor(field: string, value: string) {
    super(`Invalid ${field}: ${value}`);
    this.name = "InvalidStoredValueError";
  }
}

export async function retrySerializableReservationTransaction<T>(operation: () => Promise<T>): Promise<T> {
  let attempt = 1;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= MAX_SERIALIZABLE_TRANSACTION_ATTEMPTS || !isSerializableTransactionConflict(error)) {
        throw error;
      }
      attempt += 1;
    }
  }
}

export function isSerializableTransactionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}
