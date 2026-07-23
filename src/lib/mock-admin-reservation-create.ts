import { reserveMockStudyPeriod } from "./mock-reservation-data";
import { mockReservationUsersById as usersById, type MockUser } from "./mock-reservation-state";
import type { ReservationResult } from "./reservation-service";
import type { SessionUser } from "./session";
import type { StudyPeriod } from "./study-periods";

export function createMockAdminReservation(input: {
  readonly date: string;
  readonly now: Date;
  readonly reason: string;
  readonly studentNumber: string;
  readonly studyPeriod: StudyPeriod;
}): ReservationResult | { readonly kind: "error"; readonly reason: "admin_target" } {
  const target = [...usersById.values()].find((user) => user.studentNumber === input.studentNumber);
  if (!target) {
    return { kind: "error", reason: "not_found" };
  }
  if (target.role === "ADMIN") {
    return { kind: "error", reason: "admin_target" };
  }
  return reserveMockStudyPeriod({
    date: input.date,
    now: input.now,
    reason: input.reason,
    studyPeriod: input.studyPeriod,
    user: mockUserToSessionUser(target)
  });
}

function mockUserToSessionUser(user: MockUser): SessionUser {
  return {
    bookingStatus: user.bookingStatus,
    generation: user.generation,
    id: user.id,
    name: user.name,
    restrictionReason: user.restrictionReason,
    restrictedUntil: user.restrictedUntil ? user.restrictedUntil.toISOString() : null,
    role: user.role,
    shadowBanProfile: user.shadowBanProfile,
    studentNumber: user.studentNumber
  };
}
