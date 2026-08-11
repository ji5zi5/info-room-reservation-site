import { toKstDate } from "./date";
import type { BookingStatus, ReservationStatus } from "./reservation-service";
import { buildStudentProfilePayload } from "./student-profile";
import type { StudentProfilePayload } from "./student-profile";
import type { StudyPeriod } from "./study-periods";

export type MockStudentProfileUser = {
  readonly bookingStatus: string;
  readonly generation: number;
  readonly name: string;
  readonly restrictedUntil: Date | null;
  readonly restrictionReason: string | null;
  readonly role: string;
  readonly studentNumber: string;
};

export type MockStudentProfileReservation = {
  readonly createdAt: Date;
  readonly date: string;
  readonly status: ReservationStatus;
  readonly studyPeriod: StudyPeriod;
  readonly updatedAt: Date;
};

export function buildMockStudentProfilePayload(input: {
  readonly now: Date;
  readonly reservations: readonly MockStudentProfileReservation[];
  readonly user: MockStudentProfileUser;
}): StudentProfilePayload {
  return buildStudentProfilePayload({
    kstToday: toKstDate(input.now),
    now: input.now,
    reservations: input.reservations.map((reservation) => ({
      createdAt: reservation.createdAt,
      date: reservation.date,
      status: reservation.status,
      studyPeriod: reservation.studyPeriod,
      updatedAt: reservation.updatedAt
    })),
    sanctions: [],
    user: {
      bookingStatus: parseMockBookingStatus(input.user.bookingStatus),
      generation: input.user.generation,
      name: input.user.name,
      restrictedUntil: input.user.restrictedUntil,
      restrictionReason: input.user.restrictionReason,
      role: input.user.role,
      studentNumber: input.user.studentNumber
    }
  });
}

function parseMockBookingStatus(value: string): BookingStatus {
  switch (value) {
    case "ACTIVE":
    case "BANNED":
    case "RESTRICTED":
    case "SHADOW_BANNED":
      return value;
    default:
      throw new InvalidMockBookingStatusError(value);
  }
}

class InvalidMockBookingStatusError extends Error {
  public constructor(value: string) {
    super(`Invalid mock booking status: ${value}`);
    this.name = "InvalidMockBookingStatusError";
  }
}
