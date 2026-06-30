import { beforeEach, describe, expect, it } from "vitest";

import {
  GLOBAL_NOTIFICATION_SETTINGS_ID,
  defaultNotificationSettings,
  normalizeNotificationSettings
} from "./notification-settings";
import {
  getMockNotificationSettings,
  resetMockNotificationSettings,
  updateMockNotificationSettings
} from "./mock-notification-settings";

describe("notification settings defaults", () => {
  it("returns the global default settings when no row exists", () => {
    const settings = normalizeNotificationSettings(null);

    expect(settings).toEqual({
      closedPeriodNotificationsEnabled: true,
      id: GLOBAL_NOTIFICATION_SETTINGS_ID,
      reservationCreatedNotificationsEnabled: false
    });
  });

  it("normalizes nullable database fields to defaults", () => {
    const settings = normalizeNotificationSettings({
      closedPeriodNotificationsEnabled: null,
      id: null,
      reservationCreatedNotificationsEnabled: true
    });

    expect(settings).toEqual({
      ...defaultNotificationSettings(),
      reservationCreatedNotificationsEnabled: true
    });
  });
});

describe("mock notification settings store", () => {
  beforeEach(() => {
    resetMockNotificationSettings();
  });

  it("updates and resets global notification settings", () => {
    const updated = updateMockNotificationSettings({
      closedPeriodNotificationsEnabled: false,
      reservationCreatedNotificationsEnabled: true
    });

    expect(updated).toEqual({
      closedPeriodNotificationsEnabled: false,
      id: GLOBAL_NOTIFICATION_SETTINGS_ID,
      reservationCreatedNotificationsEnabled: true
    });
    expect(getMockNotificationSettings()).toEqual(updated);

    resetMockNotificationSettings();

    expect(getMockNotificationSettings()).toEqual(defaultNotificationSettings());
  });
});
