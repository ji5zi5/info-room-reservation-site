ALTER TABLE "NotificationSetting"
  ADD COLUMN IF NOT EXISTS "shadowBanChaosCancellationEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "shadowBanChaosCancellationRate" DOUBLE PRECISION NOT NULL DEFAULT 0.01,
  ADD COLUMN IF NOT EXISTS "shadowBanChaosCancellationWindowMinutes" INTEGER NOT NULL DEFAULT 60;
