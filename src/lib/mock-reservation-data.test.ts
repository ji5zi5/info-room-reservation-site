import { afterEach, describe, expect, it } from "vitest";

import {
  cancelMockReservation,
  getMockAdminUsers,
  getMockPeriodSummariesForUser,
  reserveMockStudyPeriod,
  resetMockReservationDataForTests,
  upsertMockReservationUser
} from "./mock-reservation-data";
import { resetMockAdminPeriodSettingsForTests, updateMockAdminPeriodSettings } from "./mock-period-settings";
import type { SessionUser } from "./session";

const student = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "mock-12345",
  name: "테스트학생",
  restrictedUntil: null,
  role: "STUDENT",
  studentNumber: "12345"
} satisfies SessionUser;

describe("mock reservation data", () => {
  afterEach(() => {
    resetMockAdminPeriodSettingsForTests();
    resetMockReservationDataForTests();
  });

  it("shares mock users and reservations with period summaries", () => {
    updateMockAdminPeriodSettings("2026-06-14", [
      { capacity: 10, closeTime: "23:59", enabled: true, openTime: "00:00", studyPeriod: "EIGHTH" },
      { capacity: 10, closeTime: "23:59", enabled: true, openTime: "00:00", studyPeriod: "FIRST" }
    ]);
    upsertMockReservationUser(student);

    const result = reserveMockStudyPeriod({
      date: "2026-06-14",
      now: new Date("2026-06-14T00:30:00.000Z"),
      studyPeriod: "EIGHTH",
      user: student
    });

    expect(result.kind).toBe("confirmed");
    expect(getMockAdminUsers({ bookingStatus: "ALL", query: "12345" })).toHaveLength(1);
    expect(getMockPeriodSummariesForUser({ currentUserId: student.id, date: "2026-06-14" })[0]).toMatchObject({
      applicants: [{ name: "테스트학생", studentNumber: "12345" }],
      confirmedCount: 1,
      myReservationId: "mock-reservation-1",
      remaining: 9
    });
  });

  it("applies the cancellation restriction in no-database mock mode", () => {
    updateMockAdminPeriodSettings("2026-06-14", [
      { capacity: 10, closeTime: "23:59", enabled: true, openTime: "00:00", studyPeriod: "EIGHTH" },
      { capacity: 10, closeTime: "23:59", enabled: true, openTime: "00:00", studyPeriod: "FIRST" }
    ]);
    upsertMockReservationUser(student);
    reserveMockStudyPeriod({
      date: "2026-06-14",
      now: new Date("2026-06-14T00:30:00.000Z"),
      studyPeriod: "EIGHTH",
      user: student
    });

    const result = cancelMockReservation({
      id: "mock-reservation-1",
      now: new Date("2026-06-14T00:40:00.000Z"),
      user: student
    });

    expect(result.kind).toBe("cancelled");
    expect(getMockAdminUsers({ bookingStatus: "RESTRICTED", query: "12345" })[0]).toMatchObject({
      bookingStatus: "RESTRICTED",
      restrictionReason: "예약 취소"
    });
  });
});
