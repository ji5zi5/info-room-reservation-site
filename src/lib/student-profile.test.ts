import { describe, expect, it } from "vitest";

import { buildStudentProfilePayload } from "./student-profile";
import type {
  StudentProfileInput,
  StudentProfileReservationRow,
  StudentProfileSanctionRow,
  StudentProfileUserRow
} from "./student-profile";

const now = new Date("2026-06-15T03:00:00.000Z");
const kstToday = "2026-06-15";

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

const sanctionRows: readonly StudentProfileSanctionRow[] = [];

function buildProfile(input: {
  readonly reservations?: readonly StudentProfileReservationRow[];
  readonly sanctions?: readonly StudentProfileSanctionRow[];
  readonly user?: StudentProfileUserRow;
}) {
  const profileInput: StudentProfileInput = {
    kstToday,
    now,
    reservations: input.reservations ?? reservationRows,
    sanctions: input.sanctions ?? sanctionRows,
    user: input.user ?? activeUser
  };

  return buildStudentProfilePayload(profileInput);
}

describe("student profile payload", () => {
  it("builds ACTIVE effective status when the user is unrestricted", () => {
    // Given
    const user: StudentProfileUserRow = { ...activeUser, bookingStatus: "ACTIVE" };

    // When
    const payload = buildProfile({ user });

    // Then
    expect(payload.effectiveStatus).toBe("ACTIVE");
    expect(payload.statusMessage).toBe("예약 가능");
  });

  it("builds BANNED effective status when the user is banned", () => {
    // Given
    const user: StudentProfileUserRow = {
      ...activeUser,
      bookingStatus: "BANNED",
      restrictionReason: "무단 미출석"
    };

    // When
    const payload = buildProfile({ user });

    // Then
    expect(payload.effectiveStatus).toBe("BANNED");
    expect(payload.statusMessage).toBe("영구 제한");
  });

  it("keeps RESTRICTED effective status when the restriction expires in the future", () => {
    // Given
    const user: StudentProfileUserRow = {
      ...activeUser,
      bookingStatus: "RESTRICTED",
      restrictionReason: "예약 취소",
      restrictedUntil: new Date("2026-06-16T03:00:00.000Z")
    };

    // When
    const payload = buildProfile({ user });

    // Then
    expect(payload.effectiveStatus).toBe("RESTRICTED");
    expect(payload.statusMessage).toBe("예약 제한");
  });

  it("keeps RESTRICTED effective status when the restriction has no expiry", () => {
    // Given
    const user: StudentProfileUserRow = {
      ...activeUser,
      bookingStatus: "RESTRICTED",
      restrictionReason: "반복 취소",
      restrictedUntil: null
    };

    // When
    const payload = buildProfile({ user });

    // Then
    expect(payload.effectiveStatus).toBe("RESTRICTED");
    expect(payload.statusMessage).toBe("예약 제한");
  });

  it("returns ACTIVE effective status when a RESTRICTED user is expired", () => {
    // Given
    const user: StudentProfileUserRow = {
      ...activeUser,
      bookingStatus: "RESTRICTED",
      restrictionReason: "예약 취소",
      restrictedUntil: new Date("2026-06-14T03:00:00.000Z")
    };

    // When
    const payload = buildProfile({ user });

    // Then
    expect(payload.effectiveStatus).toBe("ACTIVE");
    expect(payload.statusMessage).toBe("예약 가능");
  });

  it("summarizes every reservation row even when recent reservations are capped", () => {
    // Given
    const reservations = [
      row("2026-06-26", "EIGHTH", "CONFIRMED"),
      row("2026-06-25", "FIRST", "CONFIRMED"),
      row("2026-06-24", "EIGHTH", "CONFIRMED"),
      row("2026-06-23", "FIRST", "CONFIRMED"),
      row("2026-06-22", "EIGHTH", "CONFIRMED"),
      row("2026-06-21", "FIRST", "CONFIRMED"),
      row("2026-06-20", "EIGHTH", "CONFIRMED"),
      row("2026-06-19", "FIRST", "CANCELLED"),
      row("2026-06-18", "EIGHTH", "CANCELLED"),
      row("2026-06-17", "FIRST", "NO_SHOW"),
      row("2026-06-16", "EIGHTH", "NO_SHOW"),
      row("2026-06-15", "FIRST", "NO_SHOW")
    ];

    // When
    const payload = buildProfile({ reservations });

    // Then
    expect(payload.recentReservations).toHaveLength(10);
    expect(payload.reservationSummary).toEqual({ cancelledCount: 2, confirmedCount: 7, noShowCount: 3 });
  });

  it("filters current reservations by KST today and confirmed status", () => {
    // Given
    const reservations: readonly StudentProfileReservationRow[] = [
      row("2026-06-14", "EIGHTH", "CONFIRMED"),
      row("2026-06-15", "FIRST", "CANCELLED"),
      row("2026-06-15", "EIGHTH", "CONFIRMED"),
      row("2026-06-16", "FIRST", "NO_SHOW"),
      row("2026-06-16", "EIGHTH", "CONFIRMED")
    ];

    // When
    const payload = buildProfile({ reservations });

    // Then
    expect(payload.currentReservations.map((reservation) => `${reservation.date}:${reservation.studyPeriod}`)).toEqual(["2026-06-15:EIGHTH", "2026-06-16:EIGHTH"]);
  });

  it("serializes profile dates as ISO strings or null", () => {
    // Given
    const restrictedUntil = new Date("2026-06-17T03:00:00.000Z");
    const user: StudentProfileUserRow = {
      ...activeUser,
      bookingStatus: "RESTRICTED",
      restrictedUntil
    };
    const reservations: readonly StudentProfileReservationRow[] = [
      row("2026-06-15", "EIGHTH", "CONFIRMED")
    ];
    const sanctions: readonly StudentProfileSanctionRow[] = [
      {
        createdAt: new Date("2026-06-10T00:00:00.000Z"),
        endsAt: null,
        reason: "예약 취소",
        revokedAt: new Date("2026-06-11T00:00:00.000Z"),
        startsAt: new Date("2026-06-09T00:00:00.000Z"),
        status: "REVOKED",
        type: "RESERVATION"
      }
    ];

    // When
    const payload = buildProfile({ reservations, sanctions, user });

    // Then
    expect(payload.user.restrictedUntil).toBe("2026-06-17T03:00:00.000Z");
    expect(payload.currentReservations).toEqual([
      {
        createdAt: "2026-06-15T02:00:00.000Z",
        date: "2026-06-15",
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        updatedAt: "2026-06-15T02:05:00.000Z"
      }
    ]);
    expect(payload.recentSanctions).toEqual([
      {
        createdAt: "2026-06-10T00:00:00.000Z",
        endsAt: null,
        reason: "예약 취소",
        revokedAt: "2026-06-11T00:00:00.000Z",
        startsAt: "2026-06-09T00:00:00.000Z",
        status: "REVOKED",
        type: "RESERVATION"
      }
    ]);
  });

  it("summarizes active, permanent, revoked, and total sanctions", () => {
    // Given
    const sanctions: readonly StudentProfileSanctionRow[] = [
      sanction("ACTIVE", null, null),
      sanction("ACTIVE", new Date("2026-06-20T00:00:00.000Z"), null),
      sanction("REVOKED", new Date("2026-06-18T00:00:00.000Z"), new Date("2026-06-12T00:00:00.000Z"))
    ];

    // When
    const payload = buildProfile({ sanctions });

    // Then
    expect(payload.sanctionSummary).toEqual({ activeCount: 2, permanentCount: 1, revokedCount: 1, totalCount: 3 });
  });

  it("shapes payload with only safe public keys", () => {
    // Given
    const user = {
      ...activeUser,
      id: "user-private",
      riroId: "riro-private"
    } as const;
    const reservations = [
      {
        ...row("2026-06-15", "EIGHTH", "CONFIRMED"),
        id: "reservation-private",
        userId: "user-private"
      }
    ] as const;
    const sanctions = [
      {
        ...sanction("ACTIVE", null, null),
        actorId: "admin-private",
        id: "sanction-private",
        revokedById: "revoker-private",
        sourceActionId: "action-private",
        userId: "user-private"
      }
    ] as const;

    // When
    const payload = buildStudentProfilePayload({
      kstToday,
      now,
      reservations,
      sanctions,
      user
    });

    // Then
    expect(Object.keys(payload.user).sort()).toEqual(["bookingStatus", "generation", "name", "restrictedUntil", "restrictionReason", "role", "studentNumber"]);
    expect(payload.recentReservations.map((reservation) => Object.keys(reservation).sort())).toEqual([
      ["createdAt", "date", "status", "studyPeriod", "updatedAt"]
    ]);
    expect(payload.recentSanctions.map((sanction) => Object.keys(sanction).sort())).toEqual([
      ["createdAt", "endsAt", "reason", "revokedAt", "startsAt", "status", "type"]
    ]);
    expect(JSON.stringify(payload)).not.toContain("private");
  });
});

function row(
  date: string,
  studyPeriod: StudentProfileReservationRow["studyPeriod"],
  status: StudentProfileReservationRow["status"]
): StudentProfileReservationRow {
  return {
    createdAt: new Date(`${date}T02:00:00.000Z`),
    date,
    status,
    studyPeriod,
    updatedAt: new Date(`${date}T02:05:00.000Z`)
  };
}

function sanction(
  status: StudentProfileSanctionRow["status"],
  endsAt: Date | null,
  revokedAt: Date | null
): StudentProfileSanctionRow {
  return {
    createdAt: new Date("2026-06-10T00:00:00.000Z"),
    endsAt,
    reason: "예약 취소",
    revokedAt,
    startsAt: new Date("2026-06-09T00:00:00.000Z"),
    status,
    type: "RESERVATION"
  };
}
