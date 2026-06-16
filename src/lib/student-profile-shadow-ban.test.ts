import { describe, expect, it } from "vitest";

import { buildStudentProfilePayload } from "./student-profile";
import type { StudentProfileReservationRow, StudentProfileSanctionRow, StudentProfileUserRow } from "./student-profile";

const activeUser: StudentProfileUserRow = {
  bookingStatus: "ACTIVE",
  generation: 26,
  name: "김도윤",
  restrictionReason: null,
  restrictedUntil: null,
  role: "STUDENT",
  studentNumber: "26001"
};

const reservationRows: readonly StudentProfileReservationRow[] = [
  {
    createdAt: new Date("2026-06-15T02:00:00.000Z"),
    date: "2026-06-15",
    status: "CONFIRMED",
    studyPeriod: "EIGHTH",
    updatedAt: new Date("2026-06-15T02:05:00.000Z")
  }
];

describe("student profile shadow-ban masking", () => {
  it("masks a shadow-banned student as active and hides sanction evidence", () => {
    const user: StudentProfileUserRow = {
      ...activeUser,
      bookingStatus: "SHADOW_BANNED",
      restrictionReason: "블랙리스트",
      restrictedUntil: new Date("2026-07-01T03:00:00.000Z")
    };
    const sanctions: readonly StudentProfileSanctionRow[] = [
      {
        createdAt: new Date("2026-06-10T00:00:00.000Z"),
        endsAt: null,
        reason: "블랙리스트",
        revokedAt: null,
        startsAt: new Date("2026-06-09T00:00:00.000Z"),
        status: "ACTIVE",
        type: "ADMIN_BAN"
      }
    ];

    const payload = buildStudentProfilePayload({
      kstToday: "2026-06-15",
      now: new Date("2026-06-15T03:00:00.000Z"),
      reservations: reservationRows,
      sanctions,
      user
    });

    expect(payload).toMatchObject({
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
    expect(JSON.stringify(payload)).not.toContain("SHADOW_BANNED");
    expect(JSON.stringify(payload)).not.toContain("블랙리스트");
  });
});
