import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";
import {
  GLOBAL_NOTIFICATION_SETTINGS_ID,
  defaultNotificationSettings,
  normalizeNotificationSettings,
  type NotificationSettings,
  type NotificationSettingsPatch
} from "./notification-settings";

export async function getPrismaNotificationSettings(): Promise<NotificationSettings> {
  return withDatabaseContext({
    actor: systemDatabaseActor(),
    client: prisma,
    operation: async (transaction) =>
      normalizeNotificationSettings(
        await transaction.notificationSetting.findUnique({
          where: { id: GLOBAL_NOTIFICATION_SETTINGS_ID }
        })
      )
  });
}

export async function updatePrismaNotificationSettings(
  patch: NotificationSettingsPatch
): Promise<NotificationSettings> {
  const defaults = defaultNotificationSettings();
  const row = await withDatabaseContext({
    actor: systemDatabaseActor(),
    client: prisma,
    operation: (transaction) =>
      transaction.notificationSetting.upsert({
        create: {
          closedPeriodNotificationsEnabled:
            patch.closedPeriodNotificationsEnabled ?? defaults.closedPeriodNotificationsEnabled,
          id: GLOBAL_NOTIFICATION_SETTINGS_ID,
          reservationCreatedNotificationsEnabled:
            patch.reservationCreatedNotificationsEnabled ?? defaults.reservationCreatedNotificationsEnabled
        },
        update: notificationSettingsUpdateData(patch),
        where: { id: GLOBAL_NOTIFICATION_SETTINGS_ID }
      })
  });
  return normalizeNotificationSettings(row);
}

function notificationSettingsUpdateData(patch: NotificationSettingsPatch): NotificationSettingsPatch {
  return {
    ...(patch.closedPeriodNotificationsEnabled === undefined
      ? {}
      : { closedPeriodNotificationsEnabled: patch.closedPeriodNotificationsEnabled }),
    ...(patch.reservationCreatedNotificationsEnabled === undefined
      ? {}
      : { reservationCreatedNotificationsEnabled: patch.reservationCreatedNotificationsEnabled })
  };
}
