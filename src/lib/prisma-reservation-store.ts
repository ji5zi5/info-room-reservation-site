import { Prisma, type Reservation as PrismaReservation } from "@prisma/client";

import {
  type PeriodSetting,
  type Reservation,
  ReservationIdentityConflictError,
  type ReservationStore,
  type TransactionalReservationStore,
  type UserBookingState
} from "./reservation-service";
import { prisma } from "./db";
import {
  type DatabaseActor,
  isSerializableTransactionConflict,
  PRISMA_MUTATION_TRANSACTION_OPTIONS,
  retrySerializableMutationTransaction,
  systemDatabaseActor,
  withDatabaseMutation
} from "./db-context";
import { parseStoredStudyPeriod } from "./period-settings";
import { periodSettingReadDates, resolveEffectivePeriodSetting } from "./period-setting-values";
import type { StudyPeriod } from "./study-periods";

type PrismaTransaction = Prisma.TransactionClient;

export const PRISMA_RESERVATION_TRANSACTION_OPTIONS = PRISMA_MUTATION_TRANSACTION_OPTIONS;
export const retrySerializableReservationTransaction = retrySerializableMutationTransaction;
export { isSerializableTransactionConflict };

export class PrismaReservationStore implements TransactionalReservationStore {
  private readonly actor: DatabaseActor;

  public constructor(actor: DatabaseActor = systemDatabaseActor()) {
    this.actor = actor;
  }

  public async transaction<T>(
    lockKeys: readonly string[],
    operation: (store: ReservationStore) => Promise<T>
  ): Promise<T> {
    return withDatabaseMutation({
      actor: this.actor,
      client: prisma,
      lockKeys,
      operation: async (transaction) => operation(new PrismaReservationStoreUnit(transaction))
    });
  }
}

export const prismaReservationStore = new PrismaReservationStore();

export function createPrismaReservationStoreForActor(actor: DatabaseActor): PrismaReservationStore {
  return new PrismaReservationStore(actor);
}

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
    const existing = await this.client.reservation.findUnique({
      where: reservationIdentity(input)
    });
    if (existing) {
      throw new ReservationIdentityConflictError();
    }

    try {
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
    } catch (error) {
      if (!isReservationIdentityConflict(error)) {
        throw error;
      }
      throw new ReservationIdentityConflictError();
    }
  }

  public async findReservation(input: {
    readonly date: string;
    readonly studyPeriod: StudyPeriod;
    readonly userId: string;
  }): Promise<Reservation | null> {
    const reservation = await this.client.reservation.findUnique({
      where: reservationIdentity(input)
    });
    return reservation ? toReservation(reservation) : null;
  }

  public async getPeriodSetting(date: string, studyPeriod: StudyPeriod): Promise<PeriodSetting | null> {
    const settings = await this.client.periodSetting.findMany({
      where: {
        date: { in: [...periodSettingReadDates(date)] },
        studyPeriod
      }
    });
    const setting = resolveEffectivePeriodSetting(date, studyPeriod, settings);
    return { ...setting, studyPeriod: parseStoredStudyPeriod(setting.studyPeriod) };
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

function reservationIdentity(input: {
  readonly date: string;
  readonly studyPeriod: StudyPeriod;
  readonly userId: string;
}): { readonly userId_date_studyPeriod: { readonly date: string; readonly studyPeriod: StudyPeriod; readonly userId: string } } {
  return {
    userId_date_studyPeriod: {
      date: input.date,
      studyPeriod: input.studyPeriod,
      userId: input.userId
    }
  };
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

function isReservationIdentityConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
