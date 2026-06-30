export const GLOBAL_NOTIFICATION_SETTINGS_ID = "global";

export type NotificationSettings = {
  readonly closedPeriodNotificationsEnabled: boolean;
  readonly id: typeof GLOBAL_NOTIFICATION_SETTINGS_ID;
  readonly reservationCreatedNotificationsEnabled: boolean;
};

export type NotificationSettingsPatch = {
  readonly closedPeriodNotificationsEnabled?: boolean;
  readonly reservationCreatedNotificationsEnabled?: boolean;
};

export type NotificationSettingsRow = {
  readonly closedPeriodNotificationsEnabled?: boolean | null;
  readonly id?: string | null;
  readonly reservationCreatedNotificationsEnabled?: boolean | null;
} | null;

export function defaultNotificationSettings(): NotificationSettings {
  return {
    closedPeriodNotificationsEnabled: true,
    id: GLOBAL_NOTIFICATION_SETTINGS_ID,
    reservationCreatedNotificationsEnabled: false
  };
}

export function normalizeNotificationSettings(row: NotificationSettingsRow): NotificationSettings {
  const defaults = defaultNotificationSettings();
  return {
    closedPeriodNotificationsEnabled: row?.closedPeriodNotificationsEnabled ?? defaults.closedPeriodNotificationsEnabled,
    id: GLOBAL_NOTIFICATION_SETTINGS_ID,
    reservationCreatedNotificationsEnabled:
      row?.reservationCreatedNotificationsEnabled ?? defaults.reservationCreatedNotificationsEnabled
  };
}

export function applyNotificationSettingsPatch(
  settings: NotificationSettings,
  patch: NotificationSettingsPatch
): NotificationSettings {
  return {
    closedPeriodNotificationsEnabled:
      patch.closedPeriodNotificationsEnabled ?? settings.closedPeriodNotificationsEnabled,
    id: GLOBAL_NOTIFICATION_SETTINGS_ID,
    reservationCreatedNotificationsEnabled:
      patch.reservationCreatedNotificationsEnabled ?? settings.reservationCreatedNotificationsEnabled
  };
}
