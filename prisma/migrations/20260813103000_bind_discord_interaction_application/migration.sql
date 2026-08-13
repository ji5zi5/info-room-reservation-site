BEGIN;

DO $$
BEGIN
  IF to_regclass('public."DiscordInteractionJob"') IS NULL OR
     to_regclass('public."SchemaCompatibility"') IS NULL OR
     NOT EXISTS (
       SELECT 1 FROM public."SchemaCompatibility"
       WHERE "id" = 'discord-operations' AND "schemaContract" = 'discord-ops-v2'
     ) THEN
    RAISE EXCEPTION 'discord operations v2 schema contract is required';
  END IF;
END
$$;

ALTER TABLE "DiscordInteractionJob"
  ADD COLUMN "sourceApplicationId" TEXT;

CREATE OR REPLACE FUNCTION app_private.immutable_discord_interaction_job_context()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF ROW(OLD."reservationId", OLD."sourceApplicationId", OLD."sourceGuildId", OLD."sourceChannelId",
         OLD."sourceMessageId", OLD."discordActorId", OLD."localActorId", OLD."renderedEpoch",
         OLD."intent", OLD."ipHash", OLD."commandDigest")
     IS DISTINCT FROM
     ROW(NEW."reservationId", NEW."sourceApplicationId", NEW."sourceGuildId", NEW."sourceChannelId",
         NEW."sourceMessageId", NEW."discordActorId", NEW."localActorId", NEW."renderedEpoch",
         NEW."intent", NEW."ipHash", NEW."commandDigest") THEN
    RAISE EXCEPTION 'Discord interaction job context is immutable';
  END IF;
  RETURN NEW;
END;
$$;

SELECT set_config('app.application_contract', 'discord-ops-v2', true);
SELECT set_config('app.current_user_role', 'SYSTEM', true);

UPDATE "DiscordInteractionJob"
SET "claimId" = NULL,
    "claimedAt" = NULL,
    "errorCode" = 'discord_source_application_missing',
    "lastError" = 'APPLICATION_BINDING_REVIEW',
    "nextAttemptAt" = NULL,
    "status" = 'STALE',
    "terminalResult" = '{"code":"discord_source_application_missing"}'::jsonb,
    "updatedAt" = clock_timestamp()
WHERE "sourceApplicationId" IS NULL
  AND "status" IN ('PENDING', 'PROCESSING', 'RETRY');

CREATE OR REPLACE FUNCTION app_private.require_bound_discord_interaction_jobs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public."DiscordInteractionJob"
    WHERE "sourceApplicationId" IS NULL
      AND "status" IN ('PENDING', 'PROCESSING', 'RETRY')
  ) THEN
    RAISE EXCEPTION 'unbound Discord interaction jobs require review';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ApplicationDeploymentReceipt_bound_interaction_jobs"
  ON "ApplicationDeploymentReceipt";
CREATE TRIGGER "ApplicationDeploymentReceipt_bound_interaction_jobs"
BEFORE INSERT ON "ApplicationDeploymentReceipt" FOR EACH ROW
EXECUTE FUNCTION app_private.require_bound_discord_interaction_jobs();

DROP TRIGGER IF EXISTS "DiscordOperationsControl_bound_interaction_jobs"
  ON "DiscordOperationsControl";
CREATE TRIGGER "DiscordOperationsControl_bound_interaction_jobs"
BEFORE UPDATE OF "enabled" ON "DiscordOperationsControl" FOR EACH ROW
WHEN (NEW."enabled" = true AND OLD."enabled" IS DISTINCT FROM true)
EXECUTE FUNCTION app_private.require_bound_discord_interaction_jobs();

ALTER FUNCTION app_private.require_bound_discord_interaction_jobs()
  OWNER TO info_room_activation_owner;
REVOKE ALL ON FUNCTION app_private.require_bound_discord_interaction_jobs()
  FROM PUBLIC, info_room_runtime;
GRANT SELECT ON TABLE "DiscordInteractionJob" TO info_room_activation_owner;

REVOKE ALL ON FUNCTION app_private.immutable_discord_interaction_job_context()
  FROM PUBLIC, info_room_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "DiscordInteractionJob" TO info_room_runtime;

ALTER TABLE "DiscordInteractionJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DiscordInteractionJob" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "discord_interaction_job_admin_system_all" ON "DiscordInteractionJob";
CREATE POLICY "discord_interaction_job_admin_system_all" ON "DiscordInteractionJob" FOR ALL
  USING (app_private.is_admin_or_system()) WITH CHECK (app_private.is_admin_or_system());

COMMIT;
