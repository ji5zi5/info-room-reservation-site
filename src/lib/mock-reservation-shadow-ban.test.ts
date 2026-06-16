import { afterEach, describe, expect, it } from "vitest";

import {
  getMockStudentProfile,
  reserveMockStudyPeriod,
  resetMockReservationDataForTests,
  upsertMockReservationUser
} from "./mock-reservation-data";
import { resetMockAdminPeriodSettingsForTests, updateMockAdminPeriodSettings } from "./mock-period-settings";
import type { SessionUser } from "./session";

const shadowBannedStudent: SessionUser = {
  bookingStatus: "SHADOW_BANNED",
  generation: 31,
  id: "mock-shadow",
  name: "테스트학생",
  restrictionReason: "블랙리스트",
  restrictedUntil: "2026-07-01T00:00:00.000Z",
  role: "STUDENT",
  studentNumber: "12345"
};

describe("mock reservation shadow-ban masking", () => {
  afterEach(() => {
    resetMockAdminPeriodSettingsForTests();
    resetMockReservationDataForTests();
  });

  it("masks shadow-banned users in mock student profiles", () => {
    upsertMockReservationUser(shadowBannedStudent);

    const profile = getMockStudentProfile(shadowBannedStudent.id, new Date("2026-06-14T00:45:00.000Z"));

    expect(profile).toMatchObject({
      effectiveStatus: "ACTIVE",
      recentSanctions: [],
      sanctionSummary: { activeCount: 0, permanentCount: 0, revokedCount: 0, totalCount: 0 },
      statusMessage: "예약 가능",
      user: {
        bookingStatus: "ACTIVE",
        restrictedUntil: null,
        restrictionReason: null
      }
    });
    expect(JSON.stringify(profile)).not.toContain("SHADOW_BANNED");
    expect(JSON.stringify(profile)).not.toContain("블랙리스트");
  });

  it("still blocks mock reservations for raw shadow-banned users", () => {
    updateMockAdminPeriodSettings("2026-06-14", [
      { capacity: 10, closeTime: "23:59", enabled: true, openTime: "00:00", studyPeriod: "EIGHTH" }
    ]);

    expect(
      reserveMockStudyPeriod({
        date: "2026-06-14",
        now: new Date("2026-06-14T00:30:00.000Z"),
        reason: "자습",
        studyPeriod: "EIGHTH",
        user: shadowBannedStudent
      })
    ).toEqual({ kind: "error", reason: "shadow_banned" });
  });
});
