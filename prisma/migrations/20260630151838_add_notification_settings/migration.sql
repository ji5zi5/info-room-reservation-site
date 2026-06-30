CREATE TABLE "NotificationSetting" (
    "id" TEXT NOT NULL,
    "closedPeriodNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "reservationCreatedNotificationsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationSetting_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "NotificationSetting" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notification_setting_admin_system_all"
ON "NotificationSetting"
FOR ALL
USING (app_private.is_admin_or_system())
WITH CHECK (app_private.is_admin_or_system());

INSERT INTO "NotificationSetting" (
    "id",
    "closedPeriodNotificationsEnabled",
    "reservationCreatedNotificationsEnabled",
    "createdAt",
    "updatedAt"
) VALUES (
    'global',
    true,
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);
