import { describe, expect, it } from "vitest";

import {
  classifyAdminAuditAction,
  filterAdminAuditActions,
  getAdminAuditActionLabel,
  orderAdminAuditActions,
  parseAdminAuditActionFilter
} from "./admin-audit-actions";

const actions = [
  {
    action: "USER_RESTRICTION_APPLY",
    actor: { name: "관리자", studentNumber: "teacher" },
    createdAt: new Date("2026-06-12T04:30:00.000Z"),
    id: "restriction",
    reason: "예약 취소 3일 제한",
    targetUser: { name: "김학생", studentNumber: "24101" }
  },
  {
    action: "ADMIN_RESERVATION_CANCEL",
    actor: { name: "관리자", studentNumber: "teacher" },
    createdAt: new Date("2026-06-12T04:40:00.000Z"),
    id: "cancel",
    reason: "오입력",
    targetUser: { name: "박학생", studentNumber: "24102" }
  },
  {
    action: "USER_SESSIONS_REVOKE",
    actor: null,
    createdAt: new Date("2026-06-12T04:20:00.000Z"),
    id: "session",
    reason: "관리자 세션 종료",
    targetUser: { name: "이학생", studentNumber: "24103" }
  }
] as const;

describe("admin audit action helpers", () => {
  it("parses malformed filters as ALL", () => {
    expect(parseAdminAuditActionFilter("SESSION")).toBe("SESSION");
    expect(parseAdminAuditActionFilter("bad")).toBe("ALL");
    expect(parseAdminAuditActionFilter(null)).toBe("ALL");
  });

  it("classifies known admin action strings", () => {
    expect(classifyAdminAuditAction("ADMIN_RESERVATION_CREATE")).toBe("RESERVATION");
    expect(classifyAdminAuditAction("DISCORD_RESERVATION_ACCEPT")).toBe("RESERVATION");
    expect(classifyAdminAuditAction("SHADOW_BAN_CHAOS_CANCEL")).toBe("RESERVATION");
    expect(classifyAdminAuditAction("USER_RESTRICTION_REMOVE")).toBe("RESTRICTION");
    expect(classifyAdminAuditAction("STUDENT_RESERVATION_CANCEL_RESTRICTION")).toBe("RESERVATION");
    expect(classifyAdminAuditAction("USER_SESSIONS_REVOKE")).toBe("SESSION");
    expect(classifyAdminAuditAction("NO_SHOW_BAN")).toBe("NO_SHOW");
    expect(classifyAdminAuditAction("PERIOD_SETTINGS_PATCH")).toBe("SETTINGS");
    expect(classifyAdminAuditAction("CLOSED_LIST_NOTIFICATION_SEND")).toBe("NOTIFICATION");
    expect(classifyAdminAuditAction("NOTIFICATION_SETTINGS_PATCH")).toBe("NOTIFICATION");
    expect(classifyAdminAuditAction("SOMETHING_NEW")).toBe("OTHER");
  });

  it("labels manual admin reservation creation", () => {
    expect(getAdminAuditActionLabel("ADMIN_RESERVATION_CREATE")).toBe("관리자 예약 추가");
  });

  it("labels Discord reservation acceptance", () => {
    expect(getAdminAuditActionLabel("DISCORD_RESERVATION_ACCEPT")).toBe("디스코드 예약 수락");
  });

  it("labels shadow-ban chaos cancellations", () => {
    expect(getAdminAuditActionLabel("SHADOW_BAN_CHAOS_CANCEL")).toBe("블랙리스트 자동 취소");
  });

  it("maps known admin action strings to Korean labels", () => {
    expect(getAdminAuditActionLabel("NOTIFICATION_SETTINGS_PATCH")).toBe("알림 설정 변경");
    expect(getAdminAuditActionLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });

  it("filters by category and Korean query across actor, target, and reason", () => {
    expect(filterAdminAuditActions(actions, { action: "RESERVATION", query: "" }).map((action) => action.id)).toEqual([
      "cancel"
    ]);
    expect(filterAdminAuditActions(actions, { action: "ALL", query: "김학생" }).map((action) => action.id)).toEqual([
      "restriction"
    ]);
    expect(filterAdminAuditActions(actions, { action: "ALL", query: "24103" }).map((action) => action.id)).toEqual([
      "session"
    ]);
    expect(filterAdminAuditActions(actions, { action: "ALL", query: "3일" }).map((action) => action.id)).toEqual([
      "restriction"
    ]);
  });

  it("orders actions newest first", () => {
    expect(orderAdminAuditActions(actions).map((action) => action.id)).toEqual(["cancel", "restriction", "session"]);
  });
});
