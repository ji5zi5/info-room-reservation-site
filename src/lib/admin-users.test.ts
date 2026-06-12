import { describe, expect, it } from "vitest";

import { filterAdminUsers, parseAdminUserStatusFilter, type AdminUserListRow } from "./admin-users";

const users = [
  {
    bookingStatus: "ACTIVE",
    generation: 26,
    id: "u1",
    name: "김도윤",
    restrictedUntil: null,
    restrictionReason: null,
    role: "STUDENT",
    studentNumber: "26001"
  },
  {
    bookingStatus: "RESTRICTED",
    generation: 26,
    id: "u2",
    name: "박서연",
    restrictedUntil: new Date("2026-06-20T00:00:00.000Z"),
    restrictionReason: "정보실 예약 노쇼",
    role: "STUDENT",
    studentNumber: "26002"
  }
] satisfies readonly AdminUserListRow[];

describe("admin user status parsing", () => {
  it("defaults malformed filters to ALL", () => {
    expect(parseAdminUserStatusFilter(null)).toBe("ALL");
    expect(parseAdminUserStatusFilter("wat")).toBe("ALL");
    expect(parseAdminUserStatusFilter("RESTRICTED")).toBe("RESTRICTED");
  });
});

describe("admin user filtering", () => {
  it("filters by Korean name, student number, and booking status", () => {
    expect(filterAdminUsers(users, { bookingStatus: "ALL", query: "도윤" }).map((user) => user.id)).toEqual(["u1"]);
    expect(filterAdminUsers(users, { bookingStatus: "ALL", query: "26002" }).map((user) => user.id)).toEqual(["u2"]);
    expect(filterAdminUsers(users, { bookingStatus: "RESTRICTED", query: "" }).map((user) => user.id)).toEqual(["u2"]);
  });
});
