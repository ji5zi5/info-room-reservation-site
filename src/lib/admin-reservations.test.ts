import { describe, expect, it } from "vitest";

import {
  filterAdminReservations,
  filterAdminReservationsByQuery,
  orderAdminReservations,
  paginateAdminReservations,
  parseAdminReservationStatus,
  parseAdminReservationStudyPeriod,
  type AdminReservationPage
} from "./admin-reservations";

const rows = [
  {
    createdAt: new Date("2026-06-11T09:02:00.000Z"),
    id: "r1",
    status: "CONFIRMED",
    studyPeriod: "FIRST",
    user: { id: "u1", name: "김도윤", studentNumber: "26001" }
  },
  {
    createdAt: new Date("2026-06-11T09:03:00.000Z"),
    id: "r2",
    status: "CANCELLED",
    studyPeriod: "EIGHTH",
    user: { id: "u2", name: "박서연", studentNumber: "26002" }
  },
  {
    createdAt: new Date("2026-06-11T09:01:00.000Z"),
    id: "r3",
    status: "CONFIRMED",
    studyPeriod: "EIGHTH",
    user: { id: "u3", name: "이하준", studentNumber: "26003" }
  },
  {
    createdAt: new Date("2026-06-11T09:04:00.000Z"),
    id: "r4",
    status: "NO_SHOW",
    studyPeriod: "FIRST",
    user: { id: "u4", name: "최민서", studentNumber: "26004" }
  }
] as const;

describe("admin reservation filtering", () => {
  it("defaults unknown status queries to confirmed reservations", () => {
    expect(parseAdminReservationStatus(null)).toBe("CONFIRMED");
    expect(parseAdminReservationStatus("wat")).toBe("CONFIRMED");
  });

  it("filters by status and keeps all rows for ALL", () => {
    expect(filterAdminReservations(rows, "CONFIRMED")).toHaveLength(2);
    expect(filterAdminReservations(rows, "NO_SHOW")).toHaveLength(1);
    expect(filterAdminReservations(rows, "CANCELLED")).toHaveLength(1);
    expect(filterAdminReservations(rows, "ALL")).toHaveLength(4);
  });

  it("orders 8면학 before 1면학 and then by creation time", () => {
    expect(orderAdminReservations(rows).map((row) => `${row.studyPeriod}:${row.status}`)).toEqual([
      "EIGHTH:CONFIRMED",
      "EIGHTH:CANCELLED",
      "FIRST:CONFIRMED",
      "FIRST:NO_SHOW"
    ]);
  });

  it("uses id as the immutable final key when period and creation time tie", () => {
    // Given: rows whose first two immutable ordering keys are equal.
    const tied = [
      { ...rows[2], id: "z" },
      { ...rows[2], id: "a" }
    ];

    // When: the reservation ordering adapter is applied.
    const ordered = orderAdminReservations(tied);

    // Then: id provides deterministic cursor movement.
    expect(ordered.map((row) => row.id)).toEqual(["a", "z"]);
  });

  it("parses period filters and defaults malformed periods to all", () => {
    expect(parseAdminReservationStudyPeriod(null)).toBe("ALL");
    expect(parseAdminReservationStudyPeriod("EIGHTH")).toBe("EIGHTH");
    expect(parseAdminReservationStudyPeriod("FIRST")).toBe("FIRST");
    expect(parseAdminReservationStudyPeriod("wat")).toBe("ALL");
  });

  it("filters by user id, study period, Korean name, and student number", () => {
    expect(
      filterAdminReservationsByQuery(rows, {
        query: "서연",
        studyPeriod: "ALL",
        userId: null
      }).map((row) => row.user.id)
    ).toEqual(["u2"]);
    expect(
      filterAdminReservationsByQuery(rows, {
        query: "26003",
        studyPeriod: "EIGHTH",
        userId: null
      }).map((row) => row.user.id)
    ).toEqual(["u3"]);
    expect(
      filterAdminReservationsByQuery(rows, {
        query: "",
        studyPeriod: "FIRST",
        userId: "u4"
      }).map((row) => row.user.id)
    ).toEqual(["u4"]);
  });

  it("traverses 127 date-scoped reservations to a terminal cursor without duplicate ids", () => {
    // Given: a date-scoped fixture larger than two fixed pages.
    const generated = Array.from({ length: 127 }, (_, index) => ({
      createdAt: new Date(`2026-08-13T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`),
      id: `reservation-${String(index).padStart(3, "0")}`,
      status: "CONFIRMED",
      studyPeriod: index % 2 === 0 ? "EIGHTH" : "FIRST"
    } as const));
    const cutoff = new Date("2026-08-13T01:02:06.000Z");

    // When: all pages move by period, creation time, and id.
    const seen: string[] = [];
    let after: { readonly createdAt: string; readonly id: string; readonly studyPeriod: "EIGHTH" | "FIRST" } | null = null;
    do {
      const page: AdminReservationPage<(typeof generated)[number]> = paginateAdminReservations({ after, cutoff, rows: generated });
      seen.push(...page.rows.map((row) => row.id));
      after = page.next;
    } while (after !== null);

    // Then: cursor movement is complete and duplicate-free.
    expect(seen).toHaveLength(127);
    expect(new Set(seen).size).toBe(127);
  });
});
