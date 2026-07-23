import { isReservableDate } from "./advance-reservation-policy";
import { periodMutationLockKey, userMutationLockKey } from "./db-context";
import { getPeriodWindowState } from "./period-window";
import type { StudyPeriod } from "./study-periods";

export { createMemoryReservationStore } from "./memory-reservation-store";
export type BookingStatus = "ACTIVE" | "RESTRICTED" | "BANNED" | "SHADOW_BANNED";

export type ReservationStatus = "CONFIRMED" | "CANCELLED" | "NO_SHOW";

export type PeriodSetting = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly date: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: StudyPeriod;
};

export type Reservation = {
  readonly date: string;
  readonly id: string;
  readonly reason: string | null;
  readonly status: ReservationStatus;
  readonly studyPeriod: StudyPeriod;
  readonly userId: string;
};

export type UserBookingState = {
  readonly bookingStatus: BookingStatus;
  readonly restrictedUntil: Date | null;
};

export type BookingRestrictionUpdate = {
  readonly bookingStatus: "BANNED" | "RESTRICTED" | "SHADOW_BANNED";
  readonly restrictedUntil: Date | null;
  readonly restrictionReason: string;
};

export type ReservationResult =
  | {
      readonly kind: "confirmed";
      readonly reservation: Reservation;
    }
  | {
      readonly kind: "error";
      readonly reason:
        | "advance_unavailable"
        | "closed"
        | "disabled"
        | "duplicate"
        | "full"
        | "not_found"
        | "not_open_yet"
        | "restricted"
        | "shadow_banned";
    };

export interface ReservationStore {
  countConfirmedReservations(date: string, studyPeriod: StudyPeriod): Promise<number>;
  createReservation(input: {
    readonly date: string;
    readonly reason: string;
    readonly studyPeriod: StudyPeriod;
    readonly userId: string;
  }): Promise<Reservation>;
  findReservation(input: {
    readonly date: string;
    readonly studyPeriod: StudyPeriod;
    readonly userId: string;
  }): Promise<Reservation | null>;
  getPeriodSetting(date: string, studyPeriod: StudyPeriod): Promise<PeriodSetting | null>;
  getUserBookingState(userId: string): Promise<UserBookingState | null>;
}

export interface TransactionalReservationStore {
  transaction<T>(lockKeys: readonly string[], operation: (store: ReservationStore) => Promise<T>): Promise<T>;
}

export class ReservationIdentityConflictError extends Error {
  public constructor() {
    super("Reservation identity already exists");
    this.name = "ReservationIdentityConflictError";
  }
}

export type ReserveStudyPeriodInput = {
  readonly date: string;
  readonly now: Date;
  readonly reason: string;
  readonly store: TransactionalReservationStore;
  readonly studyPeriod: StudyPeriod;
  readonly userId: string;
};

const STUDENT_CANCELLATION_RESTRICTION_MS = 3 * 24 * 60 * 60 * 1000;

export function buildStudentCancellationRestriction(now: Date): BookingRestrictionUpdate {
  return {
    bookingStatus: "RESTRICTED",
    restrictedUntil: new Date(now.getTime() + STUDENT_CANCELLATION_RESTRICTION_MS),
    restrictionReason: "예약 취소"
  };
}

export function buildNoShowBan(reason: string): BookingRestrictionUpdate {
  return {
    bookingStatus: "BANNED",
    restrictedUntil: null,
    restrictionReason: reason
  };
}

export async function reserveStudyPeriod(input: ReserveStudyPeriodInput): Promise<ReservationResult> {
  try {
    return await input.store.transaction(
      [periodMutationLockKey(input.date, input.studyPeriod), userMutationLockKey(input.userId)],
      async (store) => {
        const userState = await store.getUserBookingState(input.userId);
        if (!userState) {
          return { kind: "error", reason: "not_found" };
        }

        if (userState.bookingStatus === "SHADOW_BANNED") {
          return { kind: "error", reason: "shadow_banned" };
        }

        if (isRestricted(userState, input.now)) {
          return { kind: "error", reason: "restricted" };
        }

        if (!isReservableDate(input.date, input.now)) {
          return { kind: "error", reason: "advance_unavailable" };
        }

        const setting = await store.getPeriodSetting(input.date, input.studyPeriod);
        if (!setting) {
          return { kind: "error", reason: "not_found" };
        }

        if (!setting.enabled) {
          return { kind: "error", reason: "disabled" };
        }

        const windowState = getPeriodWindowState(setting, input.now);
        if (windowState !== "open") {
          return { kind: "error", reason: windowState };
        }

        const existing = await store.findReservation({
          date: input.date,
          studyPeriod: input.studyPeriod,
          userId: input.userId
        });
        if (existing?.status === "CONFIRMED") {
          return { kind: "error", reason: "duplicate" };
        }

        const confirmedCount = await store.countConfirmedReservations(input.date, input.studyPeriod);
        if (confirmedCount >= setting.capacity) {
          return { kind: "error", reason: "full" };
        }

        const reservation = await store.createReservation({
          date: input.date,
          reason: input.reason,
          studyPeriod: input.studyPeriod,
          userId: input.userId
        });

        return { kind: "confirmed", reservation };
      }
    );
  } catch (error) {
    if (error instanceof ReservationIdentityConflictError) {
      return { kind: "error", reason: "duplicate" };
    }
    throw error;
  }
}

function isRestricted(userState: UserBookingState, now: Date): boolean {
  if (userState.bookingStatus === "BANNED") {
    return true;
  }
  if (userState.bookingStatus === "RESTRICTED") {
    return userState.restrictedUntil === null || userState.restrictedUntil.getTime() > now.getTime();
  }
  return false;
}
