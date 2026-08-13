import { describe, expect, it } from "vitest";

import {
  assertRestrictableUser,
  filterAdminUsers,
  normalizeAdminUserFilters,
  paginateAdminUsers,
  parseAdminUserStatusFilter,
  type AdminUserListRow,
  type AdminUserPage
} from "./admin-users";

const activeUser = {
  bookingStatus: "ACTIVE",
  generation: 26,
  id: "u1",
  name: "김도윤",
  restrictedUntil: null,
  restrictionReason: null,
  role: "STUDENT",
  shadowBanProfile: "NORMAL",
  studentNumber: "26001"
} satisfies AdminUserListRow;

const restrictedUser = {
  bookingStatus: "RESTRICTED",
  generation: 26,
  id: "u2",
  name: "박서연",
  restrictedUntil: new Date("2026-06-20T00:00:00.000Z"),
  restrictionReason: "정보실 예약 노쇼",
  role: "STUDENT",
  shadowBanProfile: "NORMAL",
  studentNumber: "26002"
} satisfies AdminUserListRow;

const shadowBannedUser = {
  bookingStatus: "SHADOW_BANNED",
  generation: 26,
  id: "u3",
  name: "최유진",
  restrictedUntil: null,
  restrictionReason: "블랙리스트",
  role: "STUDENT",
  shadowBanProfile: "HIGH",
  studentNumber: "26003"
} satisfies AdminUserListRow;

const users = [activeUser, restrictedUser, shadowBannedUser] as const;

describe("admin user status parsing", () => {
  it("defaults malformed filters to ALL", () => {
    expect(parseAdminUserStatusFilter(null)).toBe("ALL");
    expect(parseAdminUserStatusFilter("wat")).toBe("ALL");
    expect(parseAdminUserStatusFilter("RESTRICTED")).toBe("RESTRICTED");
    expect(parseAdminUserStatusFilter("SHADOW_BANNED")).toBe("SHADOW_BANNED");
  });
});

describe("admin user filtering", () => {
  it("filters by Korean name, student number, and booking status", () => {
    expect(filterAdminUsers(users, { bookingStatus: "ALL", query: "도윤" }).map((user) => user.id)).toEqual(["u1"]);
    expect(filterAdminUsers(users, { bookingStatus: "ALL", query: "26002" }).map((user) => user.id)).toEqual(["u2"]);
    expect(filterAdminUsers(users, { bookingStatus: "RESTRICTED", query: "" }).map((user) => user.id)).toEqual(["u2"]);
    expect(filterAdminUsers(users, { bookingStatus: "SHADOW_BANNED", query: "" }).map((user) => user.id)).toEqual(["u3"]);
  });

  it("normalizes cursor-bound query filters", () => {
    expect(normalizeAdminUserFilters({ bookingStatus: "ALL", query: "  KIM  " })).toEqual({
      bookingStatus: "ALL",
      query: "kim"
    });
  });

  it("traverses 127 creation-bounded users in fixed pages without duplicate ids", () => {
    // Given: 127 rows plus an insert newer than the refresh cutoff.
    const cutoff = new Date("2026-08-13T00:10:00.000Z");
    const generated = Array.from({ length: 127 }, (_, index) => ({
      createdAt: new Date(`2026-08-13T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`),
      id: `user-${String(index).padStart(3, "0")}`
    }));
    generated.push({ createdAt: new Date("2026-08-13T00:11:00.000Z"), id: "after-cutoff" });

    // When: every terminal page is traversed using only its immutable tuple.
    const seen: string[] = [];
    let after: { readonly createdAt: string; readonly id: string } | null = null;
    do {
      const page: AdminUserPage<(typeof generated)[number]> = paginateAdminUsers({ after, cutoff, rows: generated });
      seen.push(...page.rows.map((row) => row.id));
      after = page.next;
    } while (after !== null);

    // Then: all baseline ids appear once and the after-cutoff insert stays excluded.
    expect(seen).toHaveLength(127);
    expect(new Set(seen).size).toBe(127);
    expect(seen).not.toContain("after-cutoff");
  });
});

describe("admin restriction guard", () => {
  it("allows student targets but rejects self and admin targets", () => {
    expect(assertRestrictableUser({ actorId: "admin", target: activeUser })).toEqual({ kind: "ok" });
    expect(assertRestrictableUser({ actorId: "u1", target: activeUser })).toEqual({
      kind: "error",
      reason: "self_restriction"
    });
    expect(
      assertRestrictableUser({
        actorId: "admin",
        target: { ...activeUser, id: "admin2", role: "ADMIN" }
      })
    ).toEqual({ kind: "error", reason: "admin_target" });
  });
});
