import { describe, expect, it } from "vitest";

import { orderUserSanctions, summarizeUserSanctions } from "./admin-action-log";

const sanctions = [
  {
    createdAt: new Date("2026-06-11T09:00:00.000Z"),
    endsAt: new Date("2026-06-15T09:00:00.000Z"),
    id: "sanction-older",
    reason: "예약 취소",
    revokedAt: null,
    status: "ACTIVE",
    type: "CANCELLATION_RESTRICTION"
  },
  {
    createdAt: new Date("2026-06-12T09:00:00.000Z"),
    endsAt: null,
    id: "sanction-ban",
    reason: "노쇼",
    revokedAt: null,
    status: "ACTIVE",
    type: "NO_SHOW_BAN"
  },
  {
    createdAt: new Date("2026-06-10T09:00:00.000Z"),
    endsAt: new Date("2026-06-13T09:00:00.000Z"),
    id: "sanction-revoked",
    reason: "관리자 제한",
    revokedAt: new Date("2026-06-10T10:00:00.000Z"),
    status: "REVOKED",
    type: "ADMIN_RESTRICTION"
  }
] as const;

describe("admin action log helpers", () => {
  it("orders user sanctions newest first", () => {
    expect(orderUserSanctions(sanctions).map((sanction) => sanction.id)).toEqual([
      "sanction-ban",
      "sanction-older",
      "sanction-revoked"
    ]);
  });

  it("summarizes active, revoked, and permanent sanctions", () => {
    expect(summarizeUserSanctions(sanctions)).toEqual({
      activeCount: 2,
      permanentCount: 1,
      revokedCount: 1,
      totalCount: 3
    });
  });
});
