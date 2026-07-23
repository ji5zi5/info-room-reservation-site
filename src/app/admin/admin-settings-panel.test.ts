import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { AdminSettingsPanel } from "./admin-settings-panel";
import type { AdminNotificationSettings, AdminPeriodSetting } from "./admin-types";

describe("AdminSettingsPanel", () => {
  it("renders only operational Discord notification controls", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminSettingsPanel, {
        notificationSettings,
        onSave: vi.fn(),
        onUpdateNotificationSettings: vi.fn(),
        onUpdatePeriod: vi.fn(),
        periods: [periodSetting]
      })
    );

    expect(markup).toContain("마감 명단");
    expect(markup).toContain("신청 알림");
    expect(markup).not.toContain("성공확률");
    expect(markup).not.toContain("랜덤 취소");
    expect(markup).not.toContain("취소확률");
    expect(markup).not.toContain("마감 전 적용");
  });
});

const notificationSettings = {
  closedPeriodNotificationsEnabled: true,
  id: "global",
  reservationCreatedNotificationsEnabled: false
} satisfies AdminNotificationSettings;

const periodSetting = {
  capacity: 10,
  closeTime: "16:20",
  confirmedCount: 0,
  date: "2026-06-16",
  enabled: true,
  label: "8면학",
  openTime: "13:00",
  remaining: 10,
  studyPeriod: "EIGHTH",
  windowState: "open"
} satisfies AdminPeriodSetting;
