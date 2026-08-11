import { afterEach, describe, expect, it } from "vitest";

import {
  cancelMockReservation,
  getMockAdminReservations,
  getMockAdminUsers,
  getMockAdminUserDetail,
  getMockStudentProfile,
  getMockPeriodSummariesForUser,
  reserveMockStudyPeriod,
  resetMockReservationDataForTests,
  upsertMockReservationUser
} from "./mock-reservation-data";
import { resetMockAdminPeriodSettingsForTests, updateMockAdminPeriodSettings } from "./mock-period-settings";
import { mockReservations, mockReservationUsersById, type MockReservation } from "./mock-reservation-state";
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

function mockReservation(input: { readonly id: string; readonly status: MockReservation["status"] }): MockReservation {
  return {
    createdAt: new Date("2026-06-14T00:00:00.000Z"),
    date: "2026-06-14",
    id: input.id,
    reason: null,
    status: input.status,
    studyPeriod: "EIGHTH",
    updatedAt: new Date("2026-06-14T00:00:00.000Z"),
    user: {
      bookingStatus: "ACTIVE",
      id: "mock-target-student",
      name: "테스트학생",
      role: "STUDENT",
      studentNumber: "12345"
    },
    userId: "mock-target-student"
  };
}

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

  it("serializes creation and cancellation timestamps for the admin mutation contract", () => {
    // Given
    const createdAt = new Date("2026-06-14T00:30:00.000Z");
    const cancelledAt = new Date("2026-06-14T00:40:00.000Z");
    openAllMockPeriods("2026-06-14");
    upsertMockReservationUser(student);

    // When
    const created = reserveMockStudyPeriod({
      date: "2026-06-14",
      now: createdAt,
      reason: "자습",
      studyPeriod: "EIGHTH",
      user: student
    });
    const cancelled = cancelMockReservation({
      id: "mock-reservation-1",
      now: cancelledAt,
      requireConfirmed: true,
      user: { ...student, id: "mock-admin", role: "ADMIN", studentNumber: "90000" }
    });

    // Then
    expect(created).toMatchObject({
      kind: "confirmed",
      reservation: { createdAt, updatedAt: createdAt }
    });
    expect(JSON.parse(JSON.stringify(cancelled))).toMatchObject({
      kind: "cancelled",
      reservation: {
        createdAt: createdAt.toISOString(),
        status: "CANCELLED",
        updatedAt: cancelledAt.toISOString()
      }
    });
    expect(getMockAdminUserDetail(student.id)).toMatchObject({
      reservationHistory: [{ createdAt, updatedAt: cancelledAt }]
    });
    expect(getMockStudentProfile(student.id, cancelledAt)).toMatchObject({
      recentReservations: [{ createdAt: createdAt.toISOString(), updatedAt: cancelledAt.toISOString() }]
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

  it("returns only the exact confirmed reservation when reservationId bypasses general filters", () => {
    // Given
    const target = mockReservation({ id: "mock-deep-link-target", status: "CONFIRMED" });
    mockReservations.push(mockReservation({ id: "mock-general-row", status: "NO_SHOW" }), target);

    // When
    const reservations = getMockAdminReservations({
      date: "2026-06-14",
      filters: { query: "cannot-find-target", studyPeriod: "FIRST", userId: "other-student" },
      reservationId: target.id,
      status: "NO_SHOW"
    });

    // Then
    expect(reservations).toEqual([target]);
  });

  it.each(["CANCELLED", "NO_SHOW"] as const)(
    "rejects a same-slot identity with historical %s status without appending or replacing it",
    (status) => {
      // Given
      openAllMockPeriods("2026-06-14");
      upsertMockReservationUser(student);
      reserveMockStudyPeriod({
        date: "2026-06-14",
        now: new Date("2026-06-14T00:30:00.000Z"),
        reason: "첫 예약",
        studyPeriod: "EIGHTH",
        user: student
      });
      const historical = mockReservations[0];
      expect(historical).toBeDefined();
      if (!historical) {
        return;
      }
      mockReservations[0] = { ...historical, status };

      // When
      const result = reserveMockStudyPeriod({
        date: "2026-06-14",
        now: new Date("2026-06-14T00:40:00.000Z"),
        reason: "다시 예약",
        studyPeriod: "EIGHTH",
        user: student
      });

      // Then
      expect(result).toEqual({ kind: "error", reason: "duplicate" });
      expect(mockReservations).toHaveLength(1);
      expect(mockReservations[0]).toMatchObject({ id: historical.id, reason: "첫 예약", status });
    }
  );

  it("allows a different study period and date after a historical same-slot reservation", () => {
    // Given
    openAllMockPeriods("2026-06-14");
    openAllMockPeriods("2026-06-15");
    upsertMockReservationUser(student);
    reserveMockStudyPeriod({
      date: "2026-06-14",
      now: new Date("2026-06-14T00:30:00.000Z"),
      reason: "첫 예약",
      studyPeriod: "EIGHTH",
      user: student
    });
    const historical = mockReservations[0];
    expect(historical).toBeDefined();
    if (!historical) {
      return;
    }
    mockReservations[0] = { ...historical, status: "CANCELLED" };

    // When
    const differentPeriod = reserveMockStudyPeriod({
      date: "2026-06-14",
      now: new Date("2026-06-14T00:40:00.000Z"),
      reason: "다른 교시",
      studyPeriod: "FIRST",
      user: student
    });
    const differentDate = reserveMockStudyPeriod({
      date: "2026-06-15",
      now: new Date("2026-06-14T00:45:00.000Z"),
      reason: "다른 날짜",
      studyPeriod: "EIGHTH",
      user: student
    });

    // Then
    expect(differentPeriod).toMatchObject({ kind: "confirmed" });
    expect(differentDate).toMatchObject({ kind: "confirmed" });
    expect(mockReservations).toHaveLength(3);
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
      restrictedUntil: new Date("2026-07-01T00:00:00.000Z"),
      shadowBanProfile: "HIGH"
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

  it.each(["CANCELLED", "NO_SHOW"] as const)(
    "reports %s mock reservations as not cancellable when an admin requires a confirmed status",
    (status) => {
      // Given
      mockReservations.push(mockReservation({ id: "mock-admin-cancel-status", status }));
      const admin = { ...student, id: "mock-admin", role: "ADMIN", studentNumber: "90000" } satisfies SessionUser;

      // When
      const result = cancelMockReservation({
        id: "mock-admin-cancel-status",
        now: new Date("2026-06-14T00:40:00.000Z"),
        requireConfirmed: true,
        user: admin
      });

      // Then
      expect(result.kind).toBe("not_cancellable");
      expect(mockReservations).toEqual([expect.objectContaining({ id: "mock-admin-cancel-status", status })]);
    }
  );

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

  it("caps mock user detail by production selection order before applying display period order", () => {
    // Given
    upsertMockReservationUser(student);
    const reservationUser = {
      bookingStatus: "ACTIVE",
      id: student.id,
      name: student.name,
      role: student.role,
      studentNumber: student.studentNumber
    } as const;
    const newerIds = Array.from({ length: 99 }, (_, index) => `newer-${String(index).padStart(2, "0")}`);
    mockReservations.push(
      ...newerIds.map((id, index) => ({
        createdAt: new Date(Date.UTC(2030, 0, 1, 0, 0, index)),
        date: "2099-12-31",
        id,
        reason: "최근 예약",
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        updatedAt: new Date(Date.UTC(2030, 0, 1, 0, 0, index)),
        user: reservationUser,
        userId: student.id
      } satisfies MockReservation)),
      {
        createdAt: new Date("2030-01-01T00:01:01.000Z"),
        date: "2099-12-30",
        id: "boundary-eighth-later",
        reason: "조회 한도 밖 예약",
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        updatedAt: new Date("2030-01-01T00:01:01.000Z"),
        user: reservationUser,
        userId: student.id
      } satisfies MockReservation,
      {
        createdAt: new Date("2030-01-01T00:01:00.000Z"),
        date: "2099-12-30",
        id: "boundary-first-earlier",
        reason: "조회 한도 안 노쇼",
        status: "NO_SHOW",
        studyPeriod: "FIRST",
        updatedAt: new Date("2030-01-01T00:01:00.000Z"),
        user: reservationUser,
        userId: student.id
      } satisfies MockReservation
    );

    // When
    const detail = getMockAdminUserDetail(student.id);

    // Then
    expect(detail).toEqual(
      expect.objectContaining({
        currentReservations: newerIds.map((id) => expect.objectContaining({ id })),
        reservationHistory: [...newerIds, "boundary-first-earlier"].map((id) => expect.objectContaining({ id })),
        summary: { cancelledCount: 0, confirmedCount: 99, noShowCount: 1 }
      })
    );
    expect(detail).not.toEqual(
      expect.objectContaining({
        reservationHistory: expect.arrayContaining([expect.objectContaining({ id: "boundary-eighth-later" })])
      })
    );
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
