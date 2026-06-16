import { afterEach, describe, expect, it } from "vitest";

import {
  cancelMockReservation,
  getMockAdminUsers,
  getMockStudentProfile,
  getMockPeriodSummariesForUser,
  reserveMockStudyPeriod,
  resetMockReservationDataForTests,
  upsertMockReservationUser
} from "./mock-reservation-data";
import { resetMockAdminPeriodSettingsForTests, updateMockAdminPeriodSettings } from "./mock-period-settings";
import { mockReservationUsersById } from "./mock-reservation-state";
import type { SessionUser } from "./session";

const student = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "mock-12345",
  name: "테스트학생",
  restrictionReason: null,
  restrictedUntil: null,
  role: "STUDENT",
  studentNumber: "12345"
} satisfies SessionUser;

function openAllMockPeriods(date: string): void {
  updateMockAdminPeriodSettings(date, [
    { capacity: 10, closeTime: "23:59", enabled: true, openTime: "00:00", studyPeriod: "EIGHTH" },
    { capacity: 10, closeTime: "23:59", enabled: true, openTime: "00:00", studyPeriod: "FIRST" }
  ]);
}

describe("mock reservation data", () => {
  afterEach(() => {
    resetMockAdminPeriodSettingsForTests();
    resetMockReservationDataForTests();
  });

  it("shares mock users and reservations with period summaries", () => {
    openAllMockPeriods("2026-06-14");
    upsertMockReservationUser(student);

    const result = reserveMockStudyPeriod({
      date: "2026-06-14",
      now: new Date("2026-06-14T00:30:00.000Z"),
      reason: "자습",
      studyPeriod: "EIGHTH",
      user: student
    });

    expect(result.kind).toBe("confirmed");
    expect(result).toMatchObject({ reservation: { reason: "자습" } });
    expect(getMockAdminUsers({ bookingStatus: "ALL", query: "12345" })).toHaveLength(1);
    expect(getMockPeriodSummariesForUser({ currentUserId: student.id, date: "2026-06-14" })[0]).toMatchObject({
      applicants: [{ name: "테스트학생", studentNumber: "12345" }],
      confirmedCount: 1,
      myReservationId: "mock-reservation-1",
      remaining: 9
    });
  });

  it("applies the cancellation restriction in no-database mock mode", () => {
    openAllMockPeriods("2026-06-14");
    upsertMockReservationUser(student);
    reserveMockStudyPeriod({
      date: "2026-06-14",
      now: new Date("2026-06-14T00:30:00.000Z"),
      reason: "자습",
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

  it("keeps stored shadow bans when a mock student cancels an existing reservation", () => {
    const shadowBannedStudent = {
      ...student,
      bookingStatus: "SHADOW_BANNED",
      restrictionReason: "블랙리스트",
      restrictedUntil: "2026-07-01T00:00:00.000Z"
    } satisfies SessionUser;
    openAllMockPeriods("2026-06-14");
    upsertMockReservationUser(student);
    reserveMockStudyPeriod({
      date: "2026-06-14",
      now: new Date("2026-06-14T00:30:00.000Z"),
      reason: "자습",
      studyPeriod: "EIGHTH",
      user: student
    });
    mockReservationUsersById.set(student.id, {
      ...student,
      bookingStatus: "SHADOW_BANNED",
      restrictionReason: "블랙리스트",
      restrictedUntil: new Date("2026-07-01T00:00:00.000Z")
    });

    const result = cancelMockReservation({
      id: "mock-reservation-1",
      now: new Date("2026-06-14T00:40:00.000Z"),
      user: {
        ...shadowBannedStudent,
        bookingStatus: "ACTIVE",
        restrictionReason: null,
        restrictedUntil: null
      }
    });

    expect(result.kind).toBe("cancelled");
    expect(getMockAdminUsers({ bookingStatus: "SHADOW_BANNED", query: "12345" })[0]).toMatchObject({
      bookingStatus: "SHADOW_BANNED",
      restrictionReason: "블랙리스트"
    });
    expect(
      reserveMockStudyPeriod({
        date: "2026-06-14",
        now: new Date("2026-06-14T00:45:00.000Z"),
        reason: "다시 예약",
        studyPeriod: "FIRST",
        user: {
          ...shadowBannedStudent,
          bookingStatus: "ACTIVE",
          restrictionReason: null,
          restrictedUntil: null
        }
      })
    ).toEqual({ kind: "error", reason: "shadow_banned" });
  });

  it("builds a student profile from mock users and reservations after cancellation", () => {
    // Given
    openAllMockPeriods("2026-06-14");
    upsertMockReservationUser(student);
    reserveMockStudyPeriod({
      date: "2026-06-14",
      now: new Date("2026-06-14T00:30:00.000Z"),
      reason: "자습",
      studyPeriod: "EIGHTH",
      user: student
    });
    reserveMockStudyPeriod({
      date: "2026-06-14",
      now: new Date("2026-06-14T00:35:00.000Z"),
      reason: "과제",
      studyPeriod: "FIRST",
      user: student
    });
    cancelMockReservation({
      id: "mock-reservation-1",
      now: new Date("2026-06-14T00:40:00.000Z"),
      user: student
    });

    // When
    const profile = getMockStudentProfile(student.id, new Date("2026-06-14T00:45:00.000Z"));

    // Then
    expect(profile).toMatchObject({
      currentReservations: [{ date: "2026-06-14", status: "CONFIRMED", studyPeriod: "FIRST" }],
      effectiveStatus: "RESTRICTED",
      recentSanctions: [],
      reservationSummary: { cancelledCount: 1, confirmedCount: 1, noShowCount: 0 },
      sanctionSummary: { activeCount: 0, permanentCount: 0, revokedCount: 0, totalCount: 0 },
      user: {
        restrictionReason: "예약 취소"
      }
    });
  });

  it("omits internal identity and admin keys from the mock student profile payload", () => {
    // Given
    openAllMockPeriods("2026-06-14");
    upsertMockReservationUser(student);
    reserveMockStudyPeriod({
      date: "2026-06-14",
      now: new Date("2026-06-14T00:30:00.000Z"),
      reason: "자습",
      studyPeriod: "EIGHTH",
      user: student
    });
    const forbiddenKeys = [
      "adminActions",
      "actorId",
      "auditLogs",
      "revokedById",
      "riroId",
      "sessionSummary",
      "sourceActionId",
      "userId"
    ] as const;

    // When
    const profile = getMockStudentProfile(student.id, new Date("2026-06-14T00:45:00.000Z"));
    expect(profile).not.toBeNull();
    if (profile === null) {
      return;
    }
    const serializedProfile = JSON.stringify(profile);

    // Then
    for (const forbiddenKey of forbiddenKeys) {
      expect(serializedProfile).not.toContain(`"${forbiddenKey}"`);
    }
  });
});
