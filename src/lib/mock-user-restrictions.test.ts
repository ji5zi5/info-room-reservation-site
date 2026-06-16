import { afterEach, describe, expect, it } from "vitest";

import { resetMockReservationDataForTests, upsertMockReservationUser } from "./mock-reservation-data";
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
});
