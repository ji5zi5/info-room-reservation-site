ALTER TABLE "NotificationSetting"
  DROP COLUMN IF EXISTS "shadowBanChaosCancellationEnabled",
  DROP COLUMN IF EXISTS "shadowBanChaosCancellationRate",
  DROP COLUMN IF EXISTS "shadowBanChaosCancellationWindowMinutes",
  DROP COLUMN IF EXISTS "shadowBanSuccessRate";
