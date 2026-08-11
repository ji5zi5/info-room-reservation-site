CREATE TABLE "DiscordReservationMessage" (
  "reservationId" TEXT NOT NULL,
  "nonce" VARCHAR(25) NOT NULL,
  "guildId" TEXT,
  "channelId" TEXT,
  "messageId" TEXT,
  "initialSendStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "initialSendOutcome" TEXT,
  "initialSendAttempts" INTEGER NOT NULL DEFAULT 0,
  "initialSendNextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "initialSendError" TEXT,
  "initialSendClaimId" TEXT,
  "initialSendClaimedAt" TIMESTAMP(3),
  "decision" TEXT,
  "decisionDiscordActorId" TEXT,
  "decisionLocalActorId" TEXT,
  "decidedAt" TIMESTAMP(3),
  "messageRevision" INTEGER NOT NULL DEFAULT 0,
  "syncedRevision" INTEGER NOT NULL DEFAULT 0,
  "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "syncAttempts" INTEGER NOT NULL DEFAULT 0,
  "syncNextAttemptAt" TIMESTAMP(3),
  "syncError" TEXT,
  "syncClaimId" TEXT,
  "syncClaimRevision" INTEGER,
  "syncClaimedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '30 days'),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiscordReservationMessage_pkey" PRIMARY KEY ("reservationId"),
  CONSTRAINT "DiscordReservationMessage_nonce_length_check" CHECK (char_length("nonce") BETWEEN 1 AND 25),
  CONSTRAINT "DiscordReservationMessage_initial_status_check" CHECK ("initialSendStatus" IN ('PENDING', 'SENDING', 'RETRY', 'SENT', 'ABANDONED')),
  CONSTRAINT "DiscordReservationMessage_sync_status_check" CHECK ("syncStatus" IN ('PENDING', 'SYNCING', 'RETRY', 'SYNCED', 'ABANDONED')),
  CONSTRAINT "DiscordReservationMessage_revision_check" CHECK ("messageRevision" >= 0 AND "syncedRevision" >= 0 AND "syncedRevision" <= "messageRevision"),
  CONSTRAINT "DiscordReservationMessage_attempts_check" CHECK ("initialSendAttempts" >= 0 AND "syncAttempts" >= 0)
);

CREATE TABLE "DiscordInteractionReceipt" (
  "interactionId" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "messageId" TEXT,
  "intent" TEXT NOT NULL,
  "discordActorId" TEXT NOT NULL,
  "localActorId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "terminalOutcome" TEXT NOT NULL,
  "terminalResult" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '30 days'),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiscordInteractionReceipt_pkey" PRIMARY KEY ("interactionId"),
  CONSTRAINT "DiscordInteractionReceipt_status_check" CHECK ("status" = 'TERMINAL')
);

CREATE UNIQUE INDEX "DiscordReservationMessage_nonce_key" ON "DiscordReservationMessage"("nonce");
CREATE UNIQUE INDEX "DiscordReservationMessage_messageId_key" ON "DiscordReservationMessage"("messageId");
CREATE INDEX "DiscordReservationMessage_initialSendStatus_initialSendNextAttemptAt_idx" ON "DiscordReservationMessage"("initialSendStatus", "initialSendNextAttemptAt");
CREATE INDEX "DiscordReservationMessage_syncStatus_syncNextAttemptAt_idx" ON "DiscordReservationMessage"("syncStatus", "syncNextAttemptAt");
CREATE INDEX "DiscordReservationMessage_expiresAt_idx" ON "DiscordReservationMessage"("expiresAt");
CREATE UNIQUE INDEX "DiscordInteractionReceipt_reservationId_key" ON "DiscordInteractionReceipt"("reservationId");
CREATE INDEX "DiscordInteractionReceipt_expiresAt_status_idx" ON "DiscordInteractionReceipt"("expiresAt", "status");

ALTER TABLE "DiscordReservationMessage"
  ADD CONSTRAINT "DiscordReservationMessage_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscordInteractionReceipt"
  ADD CONSTRAINT "DiscordInteractionReceipt_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION app_private.bump_discord_reservation_message_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD."status" IS DISTINCT FROM NEW."status" AND NEW."status" IN ('CANCELLED', 'NO_SHOW') THEN
    UPDATE "public"."DiscordReservationMessage"
    SET
      "messageRevision" = "messageRevision" + 1,
      "syncStatus" = 'PENDING',
      "syncAttempts" = 0,
      "syncNextAttemptAt" = pg_catalog.clock_timestamp(),
      "syncError" = NULL,
      "syncClaimId" = NULL,
      "syncClaimRevision" = NULL,
      "syncClaimedAt" = NULL,
      "updatedAt" = pg_catalog.clock_timestamp()
    WHERE "reservationId" = NEW."id";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Reservation_discord_message_revision"
AFTER UPDATE OF "status" ON "Reservation"
FOR EACH ROW EXECUTE FUNCTION app_private.bump_discord_reservation_message_revision();

REVOKE ALL ON FUNCTION app_private.bump_discord_reservation_message_revision() FROM PUBLIC;

ALTER TABLE "DiscordReservationMessage" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "discord_reservation_message_admin_system_all"
ON "DiscordReservationMessage" FOR ALL
USING (app_private.is_admin_or_system())
WITH CHECK (app_private.is_admin_or_system());

ALTER TABLE "DiscordInteractionReceipt" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "discord_interaction_receipt_admin_system_all"
ON "DiscordInteractionReceipt" FOR ALL
USING (app_private.is_admin_or_system())
WITH CHECK (app_private.is_admin_or_system());
