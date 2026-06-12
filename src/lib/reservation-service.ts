import { isReservableDate } from "./advance-reservation-policy";
import type { StudyPeriod } from "./study-periods";

export { createMemoryReservationStore } from "./memory-reservation-store";

export type BookingStatus = "ACTIVE" | "RESTRICTED" | "BANNED";

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
  readonly status: ReservationStatus;
  readonly studyPeriod: StudyPeriod;
  readonly userId: string;
};

export type UserBookingState = {
  readonly bookingStatus: BookingStatus;
  readonly restrictedUntil: Date | null;
};

export type BookingRestrictionUpdate = {
  readonly bookingStatus: "BANNED" | "RESTRICTED";
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
        | "restricted";
    };

export interface ReservationStore {
  countConfirmedReservations(date: string, studyPeriod: StudyPeriod): Promise<number>;
  createReservation(input: {
    readonly date: string;
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
  transaction<T>(operation: (store: ReservationStore) => Promise<T>): Promise<T>;
}

export type ReserveStudyPeriodInput = {
  readonly date: string;
  readonly now: Date;
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
  return input.store.transaction(async (store) => {
    const userState = await store.getUserBookingState(input.userId);
    if (!userState) {
      return { kind: "error", reason: "not_found" };
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

    const windowState = getWindowState(setting, input.now);
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
      studyPeriod: input.studyPeriod,
      userId: input.userId
    });

    return { kind: "confirmed", reservation };
  });
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

function getWindowState(setting: PeriodSetting, now: Date): "closed" | "not_open_yet" | "open" {
  const kst = getKstDateTime(now);
  if (kst.date > setting.date) {
    return "closed";
  }

  const nowMinutes = toMinutes(kst.time);
  if (nowMinutes < toMinutes(setting.openTime)) {
    return "not_open_yet";
  }
  if (nowMinutes > toMinutes(setting.closeTime)) {
    return "closed";
  }
  return "open";
}

function getKstDateTime(date: Date): { readonly date: string; readonly time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Seoul",
    year: "numeric"
  }).formatToParts(date);

  const year = getDatePart(parts, "year");
  const month = getDatePart(parts, "month");
  const day = getDatePart(parts, "day");
  const hour = getDatePart(parts, "hour");
  const minute = getDatePart(parts, "minute");

  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`
  };
}

function getDatePart(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const part = parts.find((candidate) => candidate.type === type);
  if (!part) {
    throw new ReservationDateFormatError(type);
  }
  return part.value;
}

function toMinutes(time: string): number {
  const [hourText, minuteText] = time.split(":");
  const hour = Number.parseInt(hourText ?? "", 10);
  const minute = Number.parseInt(minuteText ?? "", 10);
  return hour * 60 + minute;
}

class ReservationDateFormatError extends Error {
  public constructor(part: Intl.DateTimeFormatPartTypes) {
    super(`KST date part not found: ${part}`);
    this.name = "ReservationDateFormatError";
  }
}
