import { describe, expect, it } from "vitest";

import { buildStudentNotifications } from "./student-notifications";

describe("student notifications", () => {
  it("builds a student-facing notification from an admin reservation cancellation", () => {
    // Given
    const rows = [
      {
        action: "ADMIN_RESERVATION_CANCEL",
        createdAt: new Date("2026-06-16T04:30:00.000Z"),
        id: "action-cancel",
        reservation: { date: "2026-06-17", studyPeriod: "EIGHTH" }
      }
    ] as const;

    // When
    const notifications = buildStudentNotifications(rows);

    // Then
    expect(notifications).toEqual([
      {
        createdAt: "2026-06-16T04:30:00.000Z",
        id: "action-cancel",
        message: "2026-06-17 8면학 신청이 취소되었습니다.",
        title: "관리자 취소 안내"
      }
    ]);
  });

  it("does not expose unrelated admin actions as student notifications", () => {
    // Given
    const rows = [
      {
        action: "USER_RESTRICTION_APPLY",
        createdAt: new Date("2026-06-16T04:30:00.000Z"),
        id: "action-restriction",
        reservation: null
      }
    ] as const;

    // When
    const notifications = buildStudentNotifications(rows);

    // Then
    expect(notifications).toEqual([]);
  });
});
