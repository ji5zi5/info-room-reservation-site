import {
  applyNotificationSettingsPatch,
  defaultNotificationSettings,
  type NotificationSettings,
  type NotificationSettingsPatch
} from "./notification-settings";

let mockNotificationSettings = defaultNotificationSettings();

export function getMockNotificationSettings(): NotificationSettings {
  return mockNotificationSettings;
}

export function updateMockNotificationSettings(patch: NotificationSettingsPatch): NotificationSettings {
  mockNotificationSettings = applyNotificationSettingsPatch(mockNotificationSettings, patch);
  return mockNotificationSettings;
}

export function resetMockNotificationSettings(): void {
  mockNotificationSettings = defaultNotificationSettings();
}
