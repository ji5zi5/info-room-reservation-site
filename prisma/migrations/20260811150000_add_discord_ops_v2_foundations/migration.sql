ALTER TABLE "DiscordInteractionReceipt" DROP CONSTRAINT IF EXISTS "DiscordInteractionReceipt_reservationId_key";
DROP INDEX IF EXISTS "DiscordInteractionReceipt_reservationId_key";
CREATE INDEX "DiscordInteractionReceipt_reservationId_createdAt_idx"
  ON "DiscordInteractionReceipt"("reservationId", "createdAt");

ALTER TABLE "DiscordReservationMessage"
  DROP CONSTRAINT "DiscordReservationMessage_initial_status_check",
  DROP CONSTRAINT "DiscordReservationMessage_sync_status_check",
  ADD COLUMN "postOperationId" TEXT,
  ADD COLUMN "postOperationEpoch" INTEGER,
  ADD COLUMN "postOperationNonce" TEXT,
  ADD COLUMN "postOperationBoundary" TEXT,
  ADD COLUMN "postDeadlineAt" TIMESTAMP(3),
  ADD COLUMN "renderedSourceEpoch" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "patchOperationId" TEXT,
  ADD COLUMN "patchOperationEpoch" INTEGER,
  ADD COLUMN "patchDeadlineAt" TIMESTAMP(3),
  ADD COLUMN "pendingReviewReason" TEXT,
  ADD COLUMN "legacyControlState" TEXT NOT NULL DEFAULT 'UNCLASSIFIED',
  ADD COLUMN "legacyControlCleanedAt" TIMESTAMP(3),
  ADD COLUMN "remoteVerificationStatus" TEXT,
  ADD COLUMN "remoteVerificationCursor" TEXT,
  ADD COLUMN "remoteVerificationNextAttemptAt" TIMESTAMP(3),
  ADD CONSTRAINT "DiscordReservationMessage_initial_status_check"
    CHECK ("initialSendStatus" IN ('PENDING', 'CLAIMED', 'POSTING', 'PENDING_REVIEW', 'SENDING', 'RETRY', 'SENT', 'ABANDONED')),
  ADD CONSTRAINT "DiscordReservationMessage_sync_status_check"
    CHECK ("syncStatus" IN ('PENDING', 'CLAIMED', 'PATCHING', 'PENDING_REVIEW', 'SYNCING', 'RETRY', 'SYNCED', 'ABANDONED')),
  ADD CONSTRAINT "DiscordReservationMessage_operation_epoch_check"
    CHECK (("postOperationEpoch" IS NULL OR "postOperationEpoch" >= 0) AND
           ("patchOperationEpoch" IS NULL OR "patchOperationEpoch" >= 0) AND
           "renderedSourceEpoch" >= 0);

CREATE INDEX "DiscordReservationMessage_remoteVerificationStatus_remoteVerificationNextAttemptAt_idx"
  ON "DiscordReservationMessage"("remoteVerificationStatus", "remoteVerificationNextAttemptAt");
CREATE INDEX "DiscordReservationMessage_postOperationNonce_idx"
  ON "DiscordReservationMessage"("postOperationNonce");

CREATE TABLE "DiscordInteractionJob" (
  "interactionId" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "sourceGuildId" TEXT NOT NULL,
  "sourceChannelId" TEXT NOT NULL,
  "sourceMessageId" TEXT NOT NULL,
  "discordActorId" TEXT NOT NULL,
  "localActorId" TEXT NOT NULL,
  "renderedEpoch" INTEGER NOT NULL,
  "intent" TEXT NOT NULL,
  "ipHash" TEXT NOT NULL,
  "commandDigest" TEXT NOT NULL,
  "handshakeStatus" TEXT NOT NULL DEFAULT 'STAGED',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "claimId" TEXT,
  "claimedAt" TIMESTAMP(3),
  "terminalResult" JSONB,
  "errorCode" TEXT,
  "lastError" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '30 days'),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiscordInteractionJob_pkey" PRIMARY KEY ("interactionId"),
  CONSTRAINT "DiscordInteractionJob_handshake_status_check"
    CHECK ("handshakeStatus" IN ('STAGED', 'ACKNOWLEDGED', 'ABANDONED_UNACKED')),
  CONSTRAINT "DiscordInteractionJob_status_check"
    CHECK ("status" IN ('PENDING', 'PROCESSING', 'RETRY', 'SUCCEEDED', 'STALE', 'ABANDONED')),
  CONSTRAINT "DiscordInteractionJob_attempts_epoch_check" CHECK ("attempts" >= 0 AND "renderedEpoch" >= 0),
  CONSTRAINT "DiscordInteractionJob_reservationId_fkey" FOREIGN KEY ("reservationId")
    REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "DiscordInteractionJob_status_nextAttemptAt_idx" ON "DiscordInteractionJob"("status", "nextAttemptAt");
CREATE INDEX "DiscordInteractionJob_reservationId_createdAt_idx" ON "DiscordInteractionJob"("reservationId", "createdAt");
CREATE INDEX "DiscordInteractionJob_sourceMessageId_createdAt_idx" ON "DiscordInteractionJob"("sourceMessageId", "createdAt");
CREATE INDEX "DiscordInteractionJob_expiresAt_idx" ON "DiscordInteractionJob"("expiresAt");

CREATE TABLE "DiscordOperationsControl" (
  "id" TEXT NOT NULL DEFAULT 'discord-operations',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "epoch" INTEGER NOT NULL DEFAULT 0,
  "pendingRemoteCleanup" BOOLEAN NOT NULL DEFAULT false,
  "disabledAt" TIMESTAMP(3),
  "enabledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiscordOperationsControl_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DiscordOperationsControl_epoch_check" CHECK ("epoch" >= 0)
);

CREATE TABLE "ApplicationDeploymentReceipt" (
  "id" TEXT NOT NULL,
  "deploymentSha" TEXT NOT NULL,
  "schemaContract" TEXT NOT NULL,
  "applicationContract" TEXT NOT NULL,
  "readinessDigest" TEXT NOT NULL,
  "activationSource" TEXT NOT NULL,
  "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "ApplicationDeploymentReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ApplicationDeploymentReceipt_source_check" CHECK ("activationSource" IN ('FIRST_CRON', 'ADMIN'))
);
CREATE INDEX "ApplicationDeploymentReceipt_deploymentSha_expiresAt_idx"
  ON "ApplicationDeploymentReceipt"("deploymentSha", "expiresAt");
CREATE INDEX "ApplicationDeploymentReceipt_expiresAt_consumedAt_idx"
  ON "ApplicationDeploymentReceipt"("expiresAt", "consumedAt");

CREATE TABLE "SchemaCompatibility" (
  "id" TEXT NOT NULL DEFAULT 'discord-operations',
  "schemaContract" TEXT NOT NULL DEFAULT 'discord-ops-v2',
  "minimumApplicationContract" TEXT NOT NULL DEFAULT 'discord-ops-v1',
  "activatedAt" TIMESTAMP(3),
  "deploymentSha" TEXT,
  "activationReceiptId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SchemaCompatibility_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SchemaCompatibility_activationReceiptId_key" UNIQUE ("activationReceiptId"),
  CONSTRAINT "SchemaCompatibility_activationReceiptId_fkey" FOREIGN KEY ("activationReceiptId")
    REFERENCES "ApplicationDeploymentReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "DiscordOperationsControl" ("id", "updatedAt") VALUES ('discord-operations', CURRENT_TIMESTAMP);
INSERT INTO "SchemaCompatibility" ("id", "updatedAt") VALUES ('discord-operations', CURRENT_TIMESTAMP);

CREATE SCHEMA IF NOT EXISTS app_private;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'info_room_activation_owner') THEN
    CREATE ROLE info_room_activation_owner
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS;
  ELSIF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'info_room_activation_owner'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'info_room_activation_owner role has unsafe privileges';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'info_room_activation_executor') THEN
    CREATE ROLE info_room_activation_executor
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS;
  ELSIF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'info_room_activation_executor'
      AND (NOT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'info_room_activation_executor role has unsafe privileges';
  END IF;
END
$$;

GRANT info_room_activation_owner TO CURRENT_USER;

CREATE TABLE app_private.online_schema_migrations (
  name TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('APPLYING', 'APPLIED')),
  started_at TIMESTAMPTZ NOT NULL,
  applied_at TIMESTAMPTZ,
  last_error TEXT
);

REVOKE ALL ON TABLE app_private.online_schema_migrations FROM PUBLIC, info_room_runtime;
REVOKE INSERT, UPDATE, DELETE ON TABLE "DiscordOperationsControl", "SchemaCompatibility", "ApplicationDeploymentReceipt" FROM info_room_runtime;
GRANT SELECT ON TABLE "DiscordOperationsControl", "SchemaCompatibility", "ApplicationDeploymentReceipt" TO info_room_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "DiscordInteractionJob" TO info_room_runtime;

CREATE OR REPLACE FUNCTION app_private.discord_ops_readiness_digest()
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT 'c99eebbeec6b76f35bce411575d3f03614703fa528d27964cce6989b5356e2b4'::text $$;

CREATE OR REPLACE FUNCTION app_private.record_application_readiness(
  "fullDeploymentSha" text,
  "readinessDigest" text,
  "activationSource" text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  receipt_id text;
BEGIN
  IF current_setting('app.application_contract', true) IS DISTINCT FROM 'discord-ops-v2' THEN
    RAISE EXCEPTION 'application contract must be discord-ops-v2';
  END IF;
  IF "fullDeploymentSha" !~ '^[0-9a-f]{40}$' OR
     current_setting('app.deployment_sha', true) IS DISTINCT FROM "fullDeploymentSha" THEN
    RAISE EXCEPTION 'deployment SHA mismatch';
  END IF;
  IF "activationSource" NOT IN ('FIRST_CRON', 'ADMIN') THEN
    RAISE EXCEPTION 'invalid activation source';
  END IF;
  IF "readinessDigest" IS DISTINCT FROM app_private.discord_ops_readiness_digest() THEN
    RAISE EXCEPTION 'readiness digest mismatch';
  END IF;
  IF to_regclass('public."DiscordInteractionJob"') IS NULL OR
     to_regclass('public."DiscordOperationsControl"') IS NULL OR
     to_regclass('public."SchemaCompatibility"') IS NULL OR
     to_regclass('public."ApplicationDeploymentReceipt"') IS NULL THEN
    RAISE EXCEPTION 'discord operations v2 schema is incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."SchemaCompatibility"
    WHERE "id" = 'discord-operations' AND "schemaContract" = 'discord-ops-v2'
      AND "minimumApplicationContract" = 'discord-ops-v1' AND "activatedAt" IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public."DiscordOperationsControl"
    WHERE "id" = 'discord-operations' AND "enabled" = false
  ) THEN
    RAISE EXCEPTION 'schema must be expanded with workers disabled';
  END IF;

  receipt_id := md5(random()::text || clock_timestamp()::text || "fullDeploymentSha" || "activationSource");
  INSERT INTO public."ApplicationDeploymentReceipt" (
    "id", "deploymentSha", "schemaContract", "applicationContract", "readinessDigest",
    "activationSource", "verifiedAt", "expiresAt"
  ) VALUES (
    receipt_id, "fullDeploymentSha", 'discord-ops-v2', 'discord-ops-v2', "readinessDigest",
    "activationSource", clock_timestamp(), clock_timestamp() + interval '10 minutes'
  );
  RETURN receipt_id;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.require_application_contract()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  activated_at timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('discord-ops-v2-activation', 0));
  SELECT "activatedAt" INTO activated_at
  FROM public."SchemaCompatibility" WHERE "id" = 'discord-operations';
  IF activated_at IS NOT NULL AND
     current_setting('app.application_contract', true) IS DISTINCT FROM 'discord-ops-v2' THEN
    RAISE EXCEPTION 'active schema requires application contract discord-ops-v2';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION app_private.immutable_discord_interaction_job_context()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF ROW(OLD."reservationId", OLD."sourceGuildId", OLD."sourceChannelId", OLD."sourceMessageId",
         OLD."discordActorId", OLD."localActorId", OLD."renderedEpoch", OLD."intent", OLD."ipHash", OLD."commandDigest")
     IS DISTINCT FROM
     ROW(NEW."reservationId", NEW."sourceGuildId", NEW."sourceChannelId", NEW."sourceMessageId",
         NEW."discordActorId", NEW."localActorId", NEW."renderedEpoch", NEW."intent", NEW."ipHash", NEW."commandDigest") THEN
    RAISE EXCEPTION 'Discord interaction job context is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "DiscordInteractionJob_immutable_context"
BEFORE UPDATE ON "DiscordInteractionJob" FOR EACH ROW
EXECUTE FUNCTION app_private.immutable_discord_interaction_job_context();

CREATE OR REPLACE FUNCTION app_private.activate_application_contract(
  "fullDeploymentSha" text,
  "readinessReceiptId" text,
  "expectedSource" text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  receipt public."ApplicationDeploymentReceipt"%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('discord-ops-v2-activation', 0));

  IF "expectedSource" NOT IN ('FIRST_CRON', 'ADMIN') OR
     current_setting('app.activation_source', true) IS DISTINCT FROM "expectedSource" THEN
    RAISE EXCEPTION 'activation source setting mismatch';
  END IF;
  IF current_setting('app.application_contract', true) IS DISTINCT FROM 'discord-ops-v2' THEN
    RAISE EXCEPTION 'application contract must be discord-ops-v2';
  END IF;
  IF "fullDeploymentSha" !~ '^[0-9a-f]{40}$' OR
     current_setting('app.deployment_sha', true) IS DISTINCT FROM "fullDeploymentSha" THEN
    RAISE EXCEPTION 'deployment SHA mismatch';
  END IF;

  SELECT * INTO receipt FROM public."ApplicationDeploymentReceipt"
  WHERE "id" = "readinessReceiptId" FOR UPDATE;
  IF NOT FOUND OR receipt."activationSource" IS DISTINCT FROM "expectedSource" OR
     receipt."deploymentSha" IS DISTINCT FROM "fullDeploymentSha" OR
     receipt."schemaContract" IS DISTINCT FROM 'discord-ops-v2' OR
     receipt."applicationContract" IS DISTINCT FROM 'discord-ops-v2' OR
     receipt."readinessDigest" IS DISTINCT FROM app_private.discord_ops_readiness_digest() OR
     receipt."expiresAt" <= clock_timestamp() OR receipt."consumedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'invalid or expired readiness receipt';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."DiscordOperationsControl"
                 WHERE "id" = 'discord-operations' AND "enabled" = false) THEN
    RAISE EXCEPTION 'workers must be disabled before activation';
  END IF;
  IF EXISTS (SELECT 1 FROM public."DiscordReservationMessage"
             WHERE "initialSendStatus" = 'SENDING' OR "syncStatus" = 'SYNCING') THEN
    RAISE EXCEPTION 'legacy transport claims require reconciliation';
  END IF;
  IF EXISTS (SELECT 1 FROM public."DiscordReservationMessage"
             WHERE "legacyControlState" = 'UNCLASSIFIED') THEN
    RAISE EXCEPTION 'legacy controls require classification';
  END IF;

  UPDATE public."ApplicationDeploymentReceipt" SET "consumedAt" = clock_timestamp()
  WHERE "id" = "readinessReceiptId" AND "consumedAt" IS NULL;
  UPDATE public."SchemaCompatibility" SET
    "minimumApplicationContract" = 'discord-ops-v2', "activatedAt" = clock_timestamp(),
    "deploymentSha" = "fullDeploymentSha", "activationReceiptId" = "readinessReceiptId",
    "updatedAt" = clock_timestamp()
  WHERE "id" = 'discord-operations' AND "activatedAt" IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'schema contract is already activated'; END IF;
  UPDATE public."DiscordOperationsControl" SET
    "enabled" = true, "enabledAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
  WHERE "id" = 'discord-operations';
END;
$$;

REVOKE ALL ON FUNCTION app_private.discord_ops_readiness_digest() FROM PUBLIC, info_room_runtime;
REVOKE ALL ON FUNCTION app_private.record_application_readiness(text, text, text) FROM PUBLIC, info_room_runtime;
REVOKE ALL ON FUNCTION app_private.activate_application_contract(text, text, text) FROM PUBLIC, info_room_runtime;
REVOKE ALL ON FUNCTION app_private.require_application_contract() FROM PUBLIC, info_room_runtime;
REVOKE ALL ON FUNCTION app_private.immutable_discord_interaction_job_context() FROM PUBLIC, info_room_runtime;
GRANT USAGE, CREATE ON SCHEMA app_private TO info_room_activation_owner;
ALTER FUNCTION app_private.record_application_readiness(text, text, text) OWNER TO info_room_activation_owner;
ALTER FUNCTION app_private.activate_application_contract(text, text, text) OWNER TO info_room_activation_owner;
GRANT EXECUTE ON FUNCTION app_private.discord_ops_readiness_digest() TO info_room_activation_owner;
GRANT USAGE ON SCHEMA app_private TO info_room_activation_executor;
GRANT EXECUTE ON FUNCTION app_private.record_application_readiness(text, text, text) TO info_room_activation_executor;
GRANT EXECUTE ON FUNCTION app_private.activate_application_contract(text, text, text) TO info_room_activation_executor;
GRANT SELECT, INSERT, UPDATE ON TABLE "ApplicationDeploymentReceipt" TO info_room_activation_owner;
GRANT SELECT, UPDATE ON TABLE "SchemaCompatibility", "DiscordOperationsControl" TO info_room_activation_owner;
GRANT SELECT ON TABLE "DiscordReservationMessage" TO info_room_activation_owner;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'User', 'Session', 'CsrfToken', 'PeriodSetting', 'NotificationDelivery', 'OperationalJob',
    'NotificationSetting', 'RetentionPolicy', 'RateLimitBucket', 'Reservation',
    'DiscordReservationMessage', 'DiscordInteractionReceipt', 'DiscordInteractionJob',
    'DiscordOperationsControl', 'AdminAction', 'UserSanction', 'AuditLog'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', table_name || '_application_contract', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app_private.require_application_contract()',
      table_name || '_application_contract', table_name
    );
  END LOOP;
END;
$$;

ALTER TABLE "DiscordInteractionJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DiscordInteractionJob" FORCE ROW LEVEL SECURITY;
CREATE POLICY "discord_interaction_job_admin_system_all" ON "DiscordInteractionJob" FOR ALL
  USING (app_private.is_admin_or_system()) WITH CHECK (app_private.is_admin_or_system());

ALTER TABLE "DiscordOperationsControl" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DiscordOperationsControl" FORCE ROW LEVEL SECURITY;
CREATE POLICY "discord_operations_control_admin_system_select" ON "DiscordOperationsControl" FOR SELECT
  USING (app_private.is_admin_or_system());
CREATE POLICY "discord_operations_control_activation_update" ON "DiscordOperationsControl" FOR UPDATE
  TO info_room_activation_owner
  USING ("id" = 'discord-operations' AND "enabled" = false)
  WITH CHECK ("id" = 'discord-operations' AND "enabled" = true AND "enabledAt" IS NOT NULL);

ALTER TABLE "SchemaCompatibility" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SchemaCompatibility" FORCE ROW LEVEL SECURITY;
CREATE POLICY "schema_compatibility_admin_system_select" ON "SchemaCompatibility" FOR SELECT
  USING (app_private.is_admin_or_system());
CREATE POLICY "schema_compatibility_activation_update" ON "SchemaCompatibility" FOR UPDATE
  TO info_room_activation_owner
  USING ("id" = 'discord-operations' AND "schemaContract" = 'discord-ops-v2' AND "activatedAt" IS NULL)
  WITH CHECK (
    "id" = 'discord-operations' AND "schemaContract" = 'discord-ops-v2' AND
    "minimumApplicationContract" = 'discord-ops-v2' AND "activatedAt" IS NOT NULL AND
    "deploymentSha" = current_setting('app.deployment_sha', true) AND "activationReceiptId" IS NOT NULL
  );

ALTER TABLE "ApplicationDeploymentReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApplicationDeploymentReceipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY "application_deployment_receipt_admin_system_select" ON "ApplicationDeploymentReceipt" FOR SELECT
  USING (app_private.is_admin_or_system());
CREATE POLICY "application_deployment_receipt_activation_insert" ON "ApplicationDeploymentReceipt" FOR INSERT
  TO info_room_activation_owner
  WITH CHECK (
    "deploymentSha" = current_setting('app.deployment_sha', true) AND
    "schemaContract" = 'discord-ops-v2' AND "applicationContract" = 'discord-ops-v2' AND
    "readinessDigest" = app_private.discord_ops_readiness_digest() AND
    "activationSource" IN ('FIRST_CRON', 'ADMIN') AND "consumedAt" IS NULL
  );
CREATE POLICY "application_deployment_receipt_activation_update" ON "ApplicationDeploymentReceipt" FOR UPDATE
  TO info_room_activation_owner
  USING (
    "deploymentSha" = current_setting('app.deployment_sha', true) AND
    "activationSource" = current_setting('app.activation_source', true) AND
    "readinessDigest" = app_private.discord_ops_readiness_digest() AND
    "expiresAt" > clock_timestamp() AND "consumedAt" IS NULL
  )
  WITH CHECK (
    "deploymentSha" = current_setting('app.deployment_sha', true) AND
    "activationSource" = current_setting('app.activation_source', true) AND
    "schemaContract" = 'discord-ops-v2' AND "applicationContract" = 'discord-ops-v2' AND
    "readinessDigest" = app_private.discord_ops_readiness_digest() AND "consumedAt" IS NOT NULL
  );

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'User', 'Session', 'CsrfToken', 'PeriodSetting', 'NotificationDelivery', 'OperationalJob',
    'NotificationSetting', 'RetentionPolicy', 'RateLimitBucket', 'Reservation',
    'DiscordReservationMessage', 'DiscordInteractionReceipt', 'AdminAction', 'UserSanction', 'AuditLog'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END;
$$;
