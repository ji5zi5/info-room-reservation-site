ALTER TABLE "NotificationDelivery"
ADD COLUMN "failureCode" TEXT,
ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

CREATE TABLE "OperationalJob" (
    "job" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3) NOT NULL,
    "result" TEXT,
    "durationMs" INTEGER,
    "failureCode" TEXT,
    "oldestBacklogAt" TIMESTAMP(3),
    "backlogCount" INTEGER NOT NULL DEFAULT 0,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalJob_pkey" PRIMARY KEY ("job")
);

CREATE INDEX "OperationalJob_status_lastAttemptAt_idx" ON "OperationalJob"("status", "lastAttemptAt");
