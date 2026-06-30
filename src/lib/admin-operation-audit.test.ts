import { describe, expect, it } from "vitest";

import {
  buildClosedListNotificationAdminAction,
  buildNotificationSettingsPatchAdminAction,
  buildPeriodSettingsPatchAdminAction,
  summarizePeriodSettingsForAudit
} from "./admin-operation-audit";

const periodSettings = [
  {
    capacity: 10,
    closeTime: "16:20",
    enabled: true,
    openTime: "13:00",
    studyPeriod: "EIGHTH"
  },
  {
    capacity: 8,
    closeTime: "16:20",
    enabled: false,
    openTime: "13:00",
    studyPeriod: "FIRST"
  }
] as const;

describe("admin operation audit builders", () => {
  it("builds period settings patch admin actions with before and after snapshots", () => {
    const action = buildPeriodSettingsPatchAdminAction({
      actorId: "admin-1",
      after: periodSettings,
      before: [{ ...periodSettings[1], capacity: 9 }, { ...periodSettings[0], capacity: 11 }],
      date: "2026-06-12",
      ipHash: "ip-hash"
    });

    expect(action.action).toBe("PERIOD_SETTINGS_PATCH");
    expect(action.actorId).toBe("admin-1");
    expect(action.ipHash).toBe("ip-hash");
    expect(action.reason).toBe("시간대 설정 변경");
    if (action.before === null) {
      throw new Error("period settings patch audit should include a before snapshot");
    }
    expect(JSON.parse(action.before)).toEqual({
      date: "2026-06-12",
      periods: [
        { capacity: 11, closeTime: "16:20", enabled: true, openTime: "13:00", studyPeriod: "EIGHTH" },
        { capacity: 9, closeTime: "16:20", enabled: false, openTime: "13:00", studyPeriod: "FIRST" }
      ]
    });
    expect(JSON.parse(action.after)).toEqual({ date: "2026-06-12", periods: periodSettings });
  });

  it("summarizes period settings in 8면학 then 1면학 order", () => {
    expect(summarizePeriodSettingsForAudit([{ ...periodSettings[1] }, { ...periodSettings[0] }])).toEqual([
      periodSettings[0],
      periodSettings[1]
    ]);
  });

  it("builds closed-list notification admin actions for sent and failed attempts", () => {
    const sent = buildClosedListNotificationAdminAction({
      actorId: "admin-1",
      date: "2026-06-12",
      force: false,
      ipHash: "ip-hash",
      result: { delivery: { messageIds: ["discord-1"], status: "SENT" }, kind: "sent" },
      studyPeriod: "EIGHTH"
    });
    const failed = buildClosedListNotificationAdminAction({
      actorId: "admin-1",
      date: "2026-06-12",
      force: true,
      ipHash: "ip-hash",
      result: { delivery: { lastError: "webhook down", messageIds: [], status: "FAILED" }, kind: "failed" },
      studyPeriod: "FIRST"
    });

    expect(sent.ipHash).toBe("ip-hash");
    expect(failed.ipHash).toBe("ip-hash");
    expect(sent.reason).toBe("마감 명단 수동 전송");
    expect(JSON.parse(sent.after)).toEqual({
      date: "2026-06-12",
      force: false,
      kind: "sent",
      lastError: null,
      messageIds: ["discord-1"],
      status: "SENT",
      studyPeriod: "EIGHTH"
    });
    expect(failed.reason).toBe("마감 명단 재전송");
    expect(JSON.parse(failed.after)).toMatchObject({ kind: "failed", lastError: "webhook down", status: "FAILED" });
  });

  it("builds notification settings patch admin actions with before and after booleans", () => {
    const action = buildNotificationSettingsPatchAdminAction({
      actorId: "admin-1",
      after: {
        closedPeriodNotificationsEnabled: false,
        id: "global",
        reservationCreatedNotificationsEnabled: true
      },
      before: {
        closedPeriodNotificationsEnabled: true,
        id: "global",
        reservationCreatedNotificationsEnabled: false
      },
      ipHash: "ip-hash"
    });

    expect(action).toMatchObject({
      action: "NOTIFICATION_SETTINGS_PATCH",
      actorId: "admin-1",
      ipHash: "ip-hash",
      reason: "알림 설정 변경"
    });
    if (action.before === null) {
      throw new Error("notification settings patch audit should include a before snapshot");
    }
    expect(JSON.parse(action.before)).toEqual({
      closedPeriodNotificationsEnabled: true,
      reservationCreatedNotificationsEnabled: false
    });
    expect(JSON.parse(action.after)).toEqual({
      closedPeriodNotificationsEnabled: false,
      reservationCreatedNotificationsEnabled: true
    });
  });
});
