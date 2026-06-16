import type { BookingStatus, ReservationStatus } from "./reservation-service";
import {
  EMPTY_STUDENT_PROFILE_SANCTION_SUMMARY,
  getEffectiveBookingStatus,
  getStudentProfileStatusMessage,
  shouldExposeStudentProfileSanctions,
  toStudentFacingProfileUser
} from "./student-profile-visibility";
import { STUDY_PERIODS, type StudyPeriod } from "./study-periods";

export type EffectiveBookingStatus = BookingStatus;

export type StudentProfileUserRow = {
  readonly bookingStatus: BookingStatus;
  readonly generation: number;
  readonly name: string;
  readonly restrictionReason: string | null;
  readonly restrictedUntil: Date | null;
  readonly role: string;
  readonly studentNumber: string;
};

export type StudentProfileReservationRow = {
  readonly createdAt: Date;
  readonly date: string;
  readonly status: ReservationStatus;
  readonly studyPeriod: StudyPeriod;
  readonly updatedAt: Date;
};

export type StudentProfileSanctionStatus = "ACTIVE" | "REVOKED";

export type StudentProfileSanctionRow = {
  readonly createdAt: Date;
  readonly endsAt: Date | null;
  readonly reason: string;
  readonly revokedAt: Date | null;
  readonly startsAt: Date;
  readonly status: StudentProfileSanctionStatus;
  readonly type: string;
};

export type StudentProfileReservationSummary = {
  readonly cancelledCount: number;
  readonly confirmedCount: number;
  readonly noShowCount: number;
};

export type StudentProfileSanctionSummary = {
  readonly activeCount: number;
  readonly permanentCount: number;
  readonly revokedCount: number;
  readonly totalCount: number;
};

export type StudentProfileUserPayload = {
  readonly bookingStatus: BookingStatus;
  readonly generation: number;
  readonly name: string;
  readonly restrictionReason: string | null;
  readonly restrictedUntil: string | null;
  readonly role: string;
  readonly studentNumber: string;
};

export type StudentProfileReservationPayload = {
  readonly createdAt: string;
  readonly date: string;
  readonly status: ReservationStatus;
  readonly studyPeriod: StudyPeriod;
  readonly updatedAt: string;
};

export type StudentProfileSanctionPayload = {
  readonly createdAt: string;
  readonly endsAt: string | null;
  readonly reason: string;
  readonly revokedAt: string | null;
  readonly startsAt: string;
  readonly status: StudentProfileSanctionStatus;
  readonly type: string;
};

export type StudentProfileStatusMessage = "예약 가능" | "예약 제한" | "영구 제한";

export type StudentProfilePayload = {
  readonly currentReservations: readonly StudentProfileReservationPayload[];
  readonly effectiveStatus: EffectiveBookingStatus;
  readonly recentReservations: readonly StudentProfileReservationPayload[];
  readonly recentSanctions: readonly StudentProfileSanctionPayload[];
  readonly reservationSummary: StudentProfileReservationSummary;
  readonly sanctionSummary: StudentProfileSanctionSummary;
  readonly statusMessage: StudentProfileStatusMessage;
  readonly user: StudentProfileUserPayload;
};

export type StudentProfileInput = {
  readonly kstToday: string;
  readonly now: Date;
  readonly reservations: readonly StudentProfileReservationRow[];
  readonly sanctions: readonly StudentProfileSanctionRow[];
  readonly user: StudentProfileUserRow;
};

const RECENT_RESERVATION_LIMIT = 10;
const RECENT_SANCTION_LIMIT = 5;

export function buildStudentProfilePayload(input: StudentProfileInput): StudentProfilePayload {
  const effectiveStatus = getEffectiveBookingStatus(input.user, input.now);
  const currentReservations = orderCurrentReservations(
    input.reservations.filter((reservation) => reservation.status === "CONFIRMED" && reservation.date >= input.kstToday)
  );
  const recentReservations = orderRecentReservations(input.reservations).slice(0, RECENT_RESERVATION_LIMIT);
  const exposeSanctions = shouldExposeStudentProfileSanctions(input.user);
  const recentSanctions = exposeSanctions ? orderRecentSanctions(input.sanctions).slice(0, RECENT_SANCTION_LIMIT) : [];
  const sanctionSummary = exposeSanctions
    ? summarizeStudentProfileSanctions(input.sanctions)
    : EMPTY_STUDENT_PROFILE_SANCTION_SUMMARY;
  const user = toStudentFacingProfileUser(input.user);

  return {
    currentReservations: currentReservations.map(serializeReservation),
    effectiveStatus,
    recentReservations: recentReservations.map(serializeReservation),
    recentSanctions: recentSanctions.map(serializeSanction),
    reservationSummary: summarizeStudentProfileReservations(input.reservations),
    sanctionSummary,
    statusMessage: getStudentProfileStatusMessage(effectiveStatus),
    user
  };
}

export function summarizeStudentProfileReservations(
  reservations: readonly Pick<StudentProfileReservationRow, "status">[]
): StudentProfileReservationSummary {
  return reservations.reduce<StudentProfileReservationSummary>(
    (summary, reservation) => {
      switch (reservation.status) {
        case "CANCELLED":
          return { ...summary, cancelledCount: summary.cancelledCount + 1 };
        case "CONFIRMED":
          return { ...summary, confirmedCount: summary.confirmedCount + 1 };
        case "NO_SHOW":
          return { ...summary, noShowCount: summary.noShowCount + 1 };
        default:
          return assertNever(reservation.status);
      }
    },
    { cancelledCount: 0, confirmedCount: 0, noShowCount: 0 }
  );
}

export function summarizeStudentProfileSanctions(
  sanctions: readonly Pick<StudentProfileSanctionRow, "endsAt" | "revokedAt" | "status">[]
): StudentProfileSanctionSummary {
  return sanctions.reduce<StudentProfileSanctionSummary>(
    (summary, sanction) => {
      switch (sanction.status) {
        case "ACTIVE":
          return {
            activeCount: summary.activeCount + 1,
            permanentCount: summary.permanentCount + (sanction.endsAt === null ? 1 : 0),
            revokedCount: summary.revokedCount + (sanction.revokedAt === null ? 0 : 1),
            totalCount: summary.totalCount + 1
          };
        case "REVOKED":
          return {
            ...summary,
            revokedCount: summary.revokedCount + 1,
            totalCount: summary.totalCount + 1
          };
        default:
          return assertNever(sanction.status);
      }
    },
    { activeCount: 0, permanentCount: 0, revokedCount: 0, totalCount: 0 }
  );
}

function serializeReservation(reservation: StudentProfileReservationRow): StudentProfileReservationPayload {
  return {
    createdAt: reservation.createdAt.toISOString(),
    date: reservation.date,
    status: reservation.status,
    studyPeriod: reservation.studyPeriod,
    updatedAt: reservation.updatedAt.toISOString()
  };
}

function serializeSanction(sanction: StudentProfileSanctionRow): StudentProfileSanctionPayload {
  return {
    createdAt: sanction.createdAt.toISOString(),
    endsAt: toIsoString(sanction.endsAt),
    reason: sanction.reason,
    revokedAt: toIsoString(sanction.revokedAt),
    startsAt: sanction.startsAt.toISOString(),
    status: sanction.status,
    type: sanction.type
  };
}

function orderCurrentReservations(
  reservations: readonly StudentProfileReservationRow[]
): readonly StudentProfileReservationRow[] {
  return [...reservations].sort((left, right) => {
    const dateDelta = left.date.localeCompare(right.date);
    if (dateDelta !== 0) {
      return dateDelta;
    }
    const periodDelta = studyPeriodRank(left.studyPeriod) - studyPeriodRank(right.studyPeriod);
    if (periodDelta !== 0) {
      return periodDelta;
    }
    return left.createdAt.getTime() - right.createdAt.getTime();
  });
}

function orderRecentReservations(reservations: readonly StudentProfileReservationRow[]): readonly StudentProfileReservationRow[] {
  return [...reservations].sort((left, right) => {
    const dateDelta = right.date.localeCompare(left.date);
    if (dateDelta !== 0) {
      return dateDelta;
    }
    const periodDelta = studyPeriodRank(left.studyPeriod) - studyPeriodRank(right.studyPeriod);
    if (periodDelta !== 0) {
      return periodDelta;
    }
    return right.createdAt.getTime() - left.createdAt.getTime();
  });
}

function orderRecentSanctions(sanctions: readonly StudentProfileSanctionRow[]): readonly StudentProfileSanctionRow[] {
  return [...sanctions].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
}

function studyPeriodRank(value: StudyPeriod): number {
  return STUDY_PERIODS.findIndex((period) => period === value);
}

function toIsoString(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function assertNever(value: never): never {
  throw new UnreachableStudentProfileVariantError(String(value));
}

class UnreachableStudentProfileVariantError extends Error {
  public constructor(value: string) {
    super(`Unhandled student profile variant: ${value}`);
    this.name = "UnreachableStudentProfileVariantError";
  }
}
