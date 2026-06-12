import { describe, expect, it } from "vitest";

import { filterAdminReservations, orderAdminReservations, parseAdminReservationStatus } from "./admin-reservations";

const rows = [
  {
    createdAt: new Date("2026-06-11T09:02:00.000Z"),
    status: "CONFIRMED",
    studyPeriod: "FIRST"
  },
  {
    createdAt: new Date("2026-06-11T09:03:00.000Z"),
    status: "CANCELLED",
    studyPeriod: "EIGHTH"
  },
  {
    createdAt: new Date("2026-06-11T09:01:00.000Z"),
    status: "CONFIRMED",
    studyPeriod: "EIGHTH"
  },
  {
    createdAt: new Date("2026-06-11T09:04:00.000Z"),
    status: "NO_SHOW",
    studyPeriod: "FIRST"
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
});
