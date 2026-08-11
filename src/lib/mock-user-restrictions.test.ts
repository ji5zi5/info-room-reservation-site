import { afterEach, describe, expect, it } from "vitest";

import {
  getMockAdminReservations,
  getMockStudentProfile,
  reserveMockStudyPeriod,
  resetMockReservationDataForTests,
  upsertMockReservationUser
} from "./mock-reservation-data";
import { resetMockAdminPeriodSettingsForTests, updateMockAdminPeriodSettings } from "./mock-period-settings";
import { applyMockUserRestriction, removeMockUserRestriction } from "./mock-user-restrictions";
import type { SessionUser } from "./session";

const adminUser = {
  bookingStatus: "ACTIVE",
  generation: 0,
  id: "mock-admin",
  name: "관리자",
  restrictionReason: null,
  restrictedUntil: null,
  role: "ADMIN",
  studentNumber: "0"
} satisfies SessionUser;

const studentUser = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "mock-student",
  name: "테스트학생",
  restrictionReason: null,
  restrictedUntil: null,
  role: "STUDENT",
  studentNumber: "31001"
} satisfies SessionUser;

describe("mock user restrictions", () => {
  afterEach(() => {
    resetMockAdminPeriodSettingsForTests();
    resetMockReservationDataForTests();
  });

  it("applies and removes a mock shadow ban for local admin smoke flows", () => {
    upsertMockReservationUser(adminUser);
    upsertMockReservationUser(studentUser);

    const applied = applyMockUserRestriction({
      actorId: adminUser.id,
      bookingStatus: "SHADOW_BANNED",
      restrictedUntil: null,
      restrictionReason: "블랙리스트",
      targetUserId: studentUser.id
    });

    expect(applied).toMatchObject({
      kind: "ok",
      user: { bookingStatus: "SHADOW_BANNED", restrictionReason: "블랙리스트" }
    });

    const removed = removeMockUserRestriction({ actorId: adminUser.id, targetUserId: studentUser.id });

    expect(removed).toMatchObject({
      kind: "ok",
      user: { bookingStatus: "ACTIVE", restrictedUntil: null, restrictionReason: null }
    });
  });

  it("rejects self-restriction in mock mode", () => {
    upsertMockReservationUser(adminUser);

    expect(
      applyMockUserRestriction({
        actorId: adminUser.id,
        bookingStatus: "SHADOW_BANNED",
        restrictedUntil: null,
        restrictionReason: "블랙리스트",
        targetUserId: adminUser.id
      })
    ).toEqual({ kind: "forbidden", reason: "self_restriction" });
  });

  it("keeps current and future confirmed reservations when applying a mock shadow ban", () => {
    openAllMockPeriods("2026-06-14");
    upsertMockReservationUser(adminUser);
    upsertMockReservationUser(studentUser);
    reserveMockStudyPeriod({
      date: "2026-06-14",
      now: new Date("2026-06-14T00:30:00.000Z"),
      reason: "자습",
      studyPeriod: "EIGHTH",
      user: studentUser
    });

    const applied = applyMockUserRestriction({
      actorId: adminUser.id,
      bookingStatus: "SHADOW_BANNED",
      now: new Date("2026-06-14T00:40:00.000Z"),
      restrictedUntil: null,
      restrictionReason: "블랙리스트",
      targetUserId: studentUser.id
    });

    expect(applied).toMatchObject({ cancelledFutureReservationCount: 0, kind: "ok" });
    expect(getMockStudentProfile(studentUser.id, new Date("2026-06-14T00:45:00.000Z"))).toMatchObject({
      currentReservations: [expect.objectContaining({ date: "2026-06-14", status: "CONFIRMED" })],
      reservationSummary: { cancelledCount: 0, confirmedCount: 1, noShowCount: 0 }
    });
  });

  it("cancels only still-open same-day reservations when applying a mock hard ban", () => {
    updateMockAdminPeriodSettings(today, [
      { capacity: 10, closeTime: "16:19", enabled: true, openTime: "13:00", studyPeriod: "EIGHTH" },
      { capacity: 10, closeTime: "16:20", enabled: true, openTime: "13:00", studyPeriod: "FIRST" }
    ]);
    upsertMockReservationUser(adminUser);
    upsertMockReservationUser(studentUser);
    const reservationCreatedAt = new Date("2026-06-16T04:00:00.000Z");
    const cancellationNow = new Date("2026-06-16T07:20:00.000Z");
    for (const studyPeriod of ["EIGHTH", "FIRST"] as const) {
      reserveMockStudyPeriod({
        date: today,
        now: reservationCreatedAt,
        reason: "자습",
        studyPeriod,
        user: studentUser
      });
    }

    const applied = applyMockUserRestriction({
      actorId: adminUser.id,
      bookingStatus: "BANNED",
      now: cancellationNow,
      restrictedUntil: null,
      restrictionReason: "노쇼",
      targetUserId: studentUser.id
    });

    expect(applied).toMatchObject({ cancelledFutureReservationCount: 1, kind: "ok" });
    expect(getMockAdminReservations({ date: today, status: "ALL" })).toEqual([
      expect.objectContaining({
        createdAt: reservationCreatedAt,
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        updatedAt: reservationCreatedAt
      }),
      expect.objectContaining({
        createdAt: reservationCreatedAt,
        status: "CANCELLED",
        studyPeriod: "FIRST",
        updatedAt: cancellationNow
      })
    ]);
    expect(getMockStudentProfile(studentUser.id, cancellationNow)).toMatchObject({
      reservationSummary: { cancelledCount: 1, confirmedCount: 1, noShowCount: 0 }
    });
  });

  it("returns an idempotent result for an identical repeated mock hard ban", () => {
    upsertMockReservationUser(adminUser);
    upsertMockReservationUser(studentUser);
    const input = {
      actorId: adminUser.id,
      bookingStatus: "BANNED" as const,
      now: new Date("2026-06-16T07:20:00.000Z"),
      restrictedUntil: null,
      restrictionReason: "같은 사유",
      targetUserId: studentUser.id
    };

    applyMockUserRestriction(input);

    expect(applyMockUserRestriction(input)).toMatchObject({
      cancelledFutureReservationCount: 0,
      idempotent: true,
      kind: "ok"
    });
  });
});

const today = "2026-06-16";

function openAllMockPeriods(date: string): void {
  updateMockAdminPeriodSettings(date, [
    { capacity: 10, closeTime: "23:59", enabled: true, openTime: "00:00", studyPeriod: "EIGHTH" },
    { capacity: 10, closeTime: "23:59", enabled: true, openTime: "00:00", studyPeriod: "FIRST" }
  ]);
}
