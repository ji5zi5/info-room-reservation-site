BEGIN;

CREATE TABLE "DiscordAdminCommandJob" (
  "id" TEXT NOT NULL,
  "sourceInteractionId" TEXT NOT NULL,
  "executionInteractionId" TEXT,
  "sourceApplicationId" TEXT NOT NULL,
  "sourceGuildId" TEXT NOT NULL,
  "sourceChannelId" TEXT NOT NULL,
  "discordActorId" TEXT NOT NULL,
  "localActorId" TEXT NOT NULL,
  "draftIntent" TEXT NOT NULL,
  "reason" TEXT,
  "commandDigest" TEXT,
  "ipHash" TEXT NOT NULL,
  "handshakeStatus" TEXT NOT NULL DEFAULT 'AWAITING_REASON',
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "claimId" TEXT,
  "claimedAt" TIMESTAMP(3),
  "terminalResult" JSONB,
  "errorCode" TEXT,
  "lastError" TEXT,
  "resultDeliveryStatus" TEXT NOT NULL DEFAULT 'NOT_READY',
  "resultDeliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  "resultDeliveryNextAttemptAt" TIMESTAMP(3),
  "resultDeliveryClaimId" TEXT,
  "resultDeliveryClaimedAt" TIMESTAMP(3),
  "resultMessageId" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '30 days'),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DiscordAdminCommandJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiscordAdminCommandJob_sourceInteractionId_key"
  ON "DiscordAdminCommandJob"("sourceInteractionId");
CREATE UNIQUE INDEX "DiscordAdminCommandJob_executionInteractionId_key"
  ON "DiscordAdminCommandJob"("executionInteractionId");
CREATE INDEX "DiscordAdminCommandJob_status_nextAttemptAt_idx"
  ON "DiscordAdminCommandJob"("status", "nextAttemptAt");
CREATE INDEX "DiscordAdminCommandJob_resultDeliveryStatus_resultDeliveryNextAttemptAt_idx"
  ON "DiscordAdminCommandJob"("resultDeliveryStatus", "resultDeliveryNextAttemptAt");
CREATE INDEX "DiscordAdminCommandJob_expiresAt_idx"
  ON "DiscordAdminCommandJob"("expiresAt");

CREATE TABLE "DiscordOperationsBoard" (
  "id" TEXT NOT NULL DEFAULT 'discord-operations-board',
  "guildId" TEXT,
  "channelId" TEXT,
  "messageId" TEXT,
  "renderedDate" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "stateDigest" TEXT,
  "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "syncAttempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "claimId" TEXT,
  "claimedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "lastSyncedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DiscordOperationsBoard_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiscordOperationsBoard_messageId_key"
  ON "DiscordOperationsBoard"("messageId");
CREATE INDEX "DiscordOperationsBoard_syncStatus_nextAttemptAt_idx"
  ON "DiscordOperationsBoard"("syncStatus", "nextAttemptAt");

INSERT INTO "DiscordOperationsBoard" ("id")
VALUES ('discord-operations-board')
ON CONFLICT ("id") DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "DiscordAdminCommandJob" TO info_room_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "DiscordOperationsBoard" TO info_room_runtime;

ALTER TABLE "DiscordAdminCommandJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DiscordAdminCommandJob" FORCE ROW LEVEL SECURITY;
CREATE POLICY "discord_admin_command_job_admin_system_all" ON "DiscordAdminCommandJob" FOR ALL
  USING (app_private.is_admin_or_system()) WITH CHECK (app_private.is_admin_or_system());

ALTER TABLE "DiscordOperationsBoard" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DiscordOperationsBoard" FORCE ROW LEVEL SECURITY;
CREATE POLICY "discord_operations_board_admin_system_all" ON "DiscordOperationsBoard" FOR ALL
  USING (app_private.is_admin_or_system()) WITH CHECK (app_private.is_admin_or_system());

COMMIT;
