import { describe, expect, it } from "vitest";

import {
  buildStudentInquiryCode,
  collectStudentCurrentReservations,
  nextReservableAtLabel,
  restrictionDetailLabel
} from "./student-reservation-status";

describe("student reservation status", () => {
  it("collects current reservations from loaded period summaries", () => {
    expect(
      collectStudentCurrentReservations({
        "2026-06-15": [
          { label: "8면학", myReservationId: "reservation-1" },
          { label: "1면학", myReservationId: null }
        ],
        "2026-06-16": [{ label: "1면학", myReservationId: "reservation-2" }]
      })
    ).toEqual([
      { canCancel: true, date: "2026-06-15", label: "8면학", reservationId: "reservation-1" },
      { canCancel: true, date: "2026-06-16", label: "1면학", reservationId: "reservation-2" }
    ]);
  });

  it("shows active cancellation restrictions and the next available time", () => {
    const user = {
      bookingStatus: "RESTRICTED",
      id: "user-123456",
      restrictionReason: "예약 취소",
      restrictedUntil: "2026-06-18T04:30:00.000Z",
      studentNumber: "26001"
    };

    expect(restrictionDetailLabel(user, new Date("2026-06-15T04:30:00.000Z"))).toBe(
      "예약 취소로 인해 2026-06-18 13:30까지 제한"
    );
    expect(nextReservableAtLabel(user, new Date("2026-06-15T04:30:00.000Z"))).toBe("2026-06-18 13:30");
    expect(buildStudentInquiryCode(user)).toBe("26001-RESTRICTED-2606181330");
  });

  it("treats expired temporary restrictions as reservable", () => {
    const user = {
      bookingStatus: "RESTRICTED",
      id: "user-abcdef",
      restrictionReason: "예약 취소",
      restrictedUntil: "2026-06-14T04:30:00.000Z",
      studentNumber: "26002"
    };

    expect(restrictionDetailLabel(user, new Date("2026-06-15T04:30:00.000Z"))).toBe("제한 없음");
    expect(nextReservableAtLabel(user, new Date("2026-06-15T04:30:00.000Z"))).toBe("지금 가능");
  });
});
