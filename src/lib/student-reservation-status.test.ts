import { describe, expect, it } from "vitest";

import {
  buildStudentInquiryCode,
  collectStudentCurrentReservations,
  nextReservableAtLabel,
  restrictionDetailLabel
} from "./student-reservation-status";

describe("student reservation status", () => {
  it("collects only today and later confirmed reservations in the active KST school week", () => {
    // Given
    const now = new Date("2026-06-17T00:30:00.000Z");

    // When
    const reservations = collectStudentCurrentReservations(
      {
        "2026-06-15": [{ myReservationId: "past-reservation", studyPeriod: "EIGHTH" }],
        "2026-06-17": [
          { myReservationId: "today-eighth", studyPeriod: "EIGHTH" },
          { myReservationId: null, studyPeriod: "FIRST" }
        ],
        "2026-06-18": [{ myReservationId: "future-first", studyPeriod: "FIRST" }],
        "2026-06-20": [{ myReservationId: "weekend-reservation", studyPeriod: "EIGHTH" }],
        "2026-06-22": [{ myReservationId: "next-week-reservation", studyPeriod: "EIGHTH" }]
      },
      now
    );

    // Then
    expect(reservations).toEqual([
      {
        date: "2026-06-17",
        reservationId: "today-eighth",
        studyPeriod: "EIGHTH"
      },
      {
        date: "2026-06-18",
        reservationId: "future-first",
        studyPeriod: "FIRST"
      }
    ]);
  });

  it("uses the KST date boundary when selecting current reservations", () => {
    // Given
    const now = new Date("2026-06-16T15:30:00.000Z");

    // When
    const reservations = collectStudentCurrentReservations(
      {
        "2026-06-16": [{ myReservationId: "kst-yesterday", studyPeriod: "EIGHTH" }],
        "2026-06-17": [{ myReservationId: "kst-today", studyPeriod: "EIGHTH" }]
      },
      now
    );

    // Then
    expect(reservations.map(({ reservationId }) => reservationId)).toEqual(["kst-today"]);
  });

  it("returns navigation data without cancellation or student-private fields", () => {
    // Given
    const periods = {
      "2026-06-17": [
        {
          applicants: [{ name: "다른 학생" }],
          label: "8면학",
          myReservationId: "reservation-1",
          shadowBanProfile: { bookingStatus: "SHADOW_BANNED" },
          studyPeriod: "EIGHTH" as const
        }
      ]
    };

    // When
    const [reservation] = collectStudentCurrentReservations(periods, new Date("2026-06-17T00:30:00.000Z"));

    // Then
    expect(Object.keys(reservation ?? {}).sort()).toEqual(["date", "reservationId", "studyPeriod"]);
  });

  it("collects current reservations from loaded period summaries", () => {
    expect(
      collectStudentCurrentReservations(
        {
          "2026-06-17": [
            { myReservationId: "reservation-1", studyPeriod: "EIGHTH" },
            { myReservationId: null, studyPeriod: "FIRST" }
          ],
          "2026-06-18": [{ myReservationId: "reservation-2", studyPeriod: "FIRST" }]
        },
        new Date("2026-06-17T00:30:00.000Z")
      )
    ).toEqual([
      {
        date: "2026-06-17",
        reservationId: "reservation-1",
        studyPeriod: "EIGHTH"
      },
      {
        date: "2026-06-18",
        reservationId: "reservation-2",
        studyPeriod: "FIRST"
      }
    ]);
  });

  it("orders same-day reservations as 8면학 then 1면학", () => {
    const reservations = collectStudentCurrentReservations(
      {
        "2026-06-17": [
          { myReservationId: "reservation-2", studyPeriod: "FIRST" },
          { myReservationId: "reservation-1", studyPeriod: "EIGHTH" }
        ]
      },
      new Date("2026-06-17T00:30:00.000Z")
    );

    expect(reservations.map(({ label }) => label)).toEqual(["8면학", "1면학"]);
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
