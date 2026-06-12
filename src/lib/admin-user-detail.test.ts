import { describe, expect, it } from "vitest";

import { summarizeAdminUserReservations, orderAdminUserReservations } from "./admin-user-detail";

const reservations = [
  {
    createdAt: new Date("2026-06-10T09:00:00.000Z"),
    date: "2026-06-12",
    id: "r1",
    status: "CONFIRMED",
    studyPeriod: "FIRST",
    updatedAt: new Date("2026-06-10T09:00:00.000Z")
  },
  {
    createdAt: new Date("2026-06-10T08:00:00.000Z"),
    date: "2026-06-12",
    id: "r2",
    status: "NO_SHOW",
    studyPeriod: "EIGHTH",
    updatedAt: new Date("2026-06-10T08:00:00.000Z")
  },
  {
    createdAt: new Date("2026-06-09T08:00:00.000Z"),
    date: "2026-06-11",
    id: "r3",
    status: "CANCELLED",
    studyPeriod: "EIGHTH",
    updatedAt: new Date("2026-06-09T08:00:00.000Z")
  }
] as const;

describe("admin user detail helpers", () => {
  it("summarizes reservation statuses", () => {
    expect(summarizeAdminUserReservations(reservations)).toEqual({
      cancelledCount: 1,
      confirmedCount: 1,
      noShowCount: 1
    });
  });

  it("orders latest dates first and 8면학 before 1면학 within the date", () => {
    expect(orderAdminUserReservations(reservations).map((reservation) => reservation.id)).toEqual(["r2", "r1", "r3"]);
  });
});
