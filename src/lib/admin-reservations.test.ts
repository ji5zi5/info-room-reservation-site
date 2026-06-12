import { describe, expect, it } from "vitest";

import {
  filterAdminReservations,
  filterAdminReservationsByQuery,
  orderAdminReservations,
  parseAdminReservationStatus,
  parseAdminReservationStudyPeriod
} from "./admin-reservations";

const rows = [
  {
    createdAt: new Date("2026-06-11T09:02:00.000Z"),
    status: "CONFIRMED",
    studyPeriod: "FIRST",
    user: { id: "u1", name: "김도윤", studentNumber: "26001" }
  },
  {
    createdAt: new Date("2026-06-11T09:03:00.000Z"),
    status: "CANCELLED",
    studyPeriod: "EIGHTH",
    user: { id: "u2", name: "박서연", studentNumber: "26002" }
  },
  {
    createdAt: new Date("2026-06-11T09:01:00.000Z"),
    status: "CONFIRMED",
    studyPeriod: "EIGHTH",
    user: { id: "u3", name: "이하준", studentNumber: "26003" }
  },
  {
    createdAt: new Date("2026-06-11T09:04:00.000Z"),
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
});
