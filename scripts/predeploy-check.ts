import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { assertProductionEnvSafe, parseServerEnv, ServerEnvError } from "../src/lib/env";
import { ONLINE_INDEX_CHECKSUM, ONLINE_INDEX_MANIFEST } from "./apply-online-admin-search-indexes";

const requiredProductionKeys = [
  "APP_ORIGIN",
  "DATABASE_URL",
  "DIRECT_URL",
  "SESSION_SECRET",
  "ADMIN_STUDENT_NUMBERS",
  "CLOSED_PERIOD_CRON_SECRET",
  "MAINTENANCE_CRON_SECRET",
  "DISCORD_WEBHOOK_URL",
  "TRUST_FORWARDED_IP_HEADERS",
  "OBSERVABILITY_PROVIDER",
  "OBSERVABILITY_PROJECT_ID",
  "OPERATIONS_ALERT_DESTINATION",
  "OPERATIONS_ESCALATION_PATH",
  "OPERATIONS_OWNER"
] as const;
const fullGitShaPattern = /^[a-f0-9]{40}$/;

class OperationalStructureError extends Error {
  public override readonly name = "OperationalStructureError";
}

try {
  const env = parseServerEnv(process.env);
  const deploymentSha = resolveDeploymentSha(process.env);
  if (env.nodeEnv === "production") {
    const invalid: string[] = requiredProductionKeys.filter((key) => !process.env[key]?.trim());
    if (!deploymentSha || !fullGitShaPattern.test(deploymentSha)) {
      invalid.push("DEPLOYMENT_SHA");
    }
    if (invalid.length > 0) {
      throw new ServerEnvError(invalid);
    }
  }
  assertProductionEnvSafe(process.env);
  const operationalContracts = validateOperationalStructure();
  console.log(
    `Predeploy environment check passed. discordApplication=${env.discordApplication === null ? "webhook-only" : "enabled"} ` +
    `deploymentSha=${deploymentSha ?? "unbound"} ` +
    `migrationDigest=${migrationDigest()} ` +
    `operationalContracts=${operationalContracts} onlineIndexChecksum=${ONLINE_INDEX_CHECKSUM}`
  );
} catch (error) {
  if (error instanceof ServerEnvError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

function resolveDeploymentSha(raw: NodeJS.ProcessEnv): string | null {
  return (
    raw.DEPLOYMENT_SHA?.trim() ||
    raw.VERCEL_GIT_COMMIT_SHA?.trim() ||
    raw.GITHUB_SHA?.trim() ||
    null
  );
}

function migrationDigest(): string {
  const migrationRoot = join(process.cwd(), "prisma", "migrations");
  const migrationFiles = readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(migrationRoot, entry.name, "migration.sql")
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (migrationFiles.length === 0) {
    throw new OperationalStructureError("No Prisma migrations found.");
  }

  const hash = createHash("sha256");
  for (const migration of migrationFiles) {
    hash.update(migration.name);
    hash.update("\0");
    hash.update(readFileSync(migration.path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function validateOperationalStructure(): number {
  const root = process.cwd();
  const migration = read("prisma/migrations/20260811150000_add_discord_ops_v2_foundations/migration.sql");
  const indexes = read("scripts/apply-online-admin-search-indexes.ts");
  const activation = read("src/lib/application-contract-activation.ts");
  const databaseContext = read("src/lib/db-context.ts");
  const adminActivation = read("src/app/api/admin/operations/activate/route.ts");
  const cronActivation = read("src/app/api/cron/closed-period-notifications/route.ts");
  const rollout = read("scripts/operational-rollout-smoke.ts");
  const ci = read(".github/workflows/ci.yml");
  const packageManifest = JSON.parse(read("package.json")) as { readonly scripts?: Readonly<Record<string, string>> };
  const playwright = read("playwright.config.ts");
  const operationalQa = read("scripts/verify-operational-fomo-evidence.mjs");
  const readiness = `${read("src/lib/prisma-readiness.ts")}\n${read("src/lib/readiness.ts")}`;
  const checks: readonly (readonly [string, string, RegExp])[] = [
    ["v2 marker", migration, /"schemaContract"\s+TEXT NOT NULL DEFAULT 'discord-ops-v2'[\s\S]*"minimumApplicationContract"\s+TEXT NOT NULL DEFAULT 'discord-ops-v1'/u],
    ["online ledger", migration, /CREATE TABLE app_private\.online_schema_migrations[\s\S]*CHECK \(state IN \('APPLYING', 'APPLIED'\)\)[\s\S]*REVOKE ALL ON TABLE app_private\.online_schema_migrations/u],
    ["catalog index verifier", indexes, /(?=[\s\S]*pg_class)(?=[\s\S]*pg_namespace)(?=[\s\S]*pg_index)(?=[\s\S]*pg_am)(?=[\s\S]*pg_attribute)(?=[\s\S]*pg_opclass)(?=[\s\S]*pg_collation)(?=[\s\S]*indisready)(?=[\s\S]*indisvalid)/u],
    ["online checksum state transition", indexes, /ONLINE_INDEX_CHECKSUM[\s\S]*state='APPLYING'[\s\S]*state='APPLIED'[\s\S]*checksum=\$2/u],
    ["receipt schema", migration, /CREATE TABLE "ApplicationDeploymentReceipt"[\s\S]*"activationSource" TEXT NOT NULL[\s\S]*"verifiedAt"[\s\S]*"expiresAt"[\s\S]*"consumedAt"/u],
    ["receipt linkage", migration, /"activationReceiptId"[\s\S]*UNIQUE \("activationReceiptId"\)[\s\S]*REFERENCES "ApplicationDeploymentReceipt"\("id"\)/u],
    ["readiness function security", migration, /record_application_readiness\([\s\S]*LANGUAGE plpgsql SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/u],
    ["activation function security", migration, /activate_application_contract\([\s\S]*LANGUAGE plpgsql SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/u],
    ["narrow function grants", migration, /REVOKE ALL ON FUNCTION app_private\.record_application_readiness[\s\S]*GRANT EXECUTE ON FUNCTION app_private\.record_application_readiness\(text, text, text\) TO info_room_activation_executor[\s\S]*GRANT EXECUTE ON FUNCTION app_private\.activate_application_contract\(text, text, text\) TO info_room_activation_executor/u],
    ["shared guard lock", migration, /require_application_contract\(\)[\s\S]*pg_advisory_xact_lock_shared\(hashtextextended\('discord-ops-v2-activation', 0\)\)[\s\S]*current_setting\('app.application_contract', true\)/u],
    ["full SHA guard", `${migration}\n${databaseContext}`, /\^\[0-9a-f\]\{40\}\$[\s\S]*app\.deployment_sha/u],
    ["worker epoch fence", migration, /CREATE TABLE "DiscordOperationsControl"[\s\S]*"enabled"[\s\S]*"epoch"[\s\S]*pendingRemoteCleanup/u],
    ["rendered epoch fence", migration, /CREATE TABLE "DiscordInteractionJob"[\s\S]*"renderedEpoch"[\s\S]*ALTER TABLE "DiscordReservationMessage"|ALTER TABLE "DiscordReservationMessage"[\s\S]*"renderedSourceEpoch"[\s\S]*CREATE TABLE "DiscordInteractionJob"[\s\S]*"renderedEpoch"/u],
    ["legacy transport preservation", migration, /'SENDING'[\s\S]*'SYNCING'[\s\S]*"legacyControlState"/u],
    ["legacy recovery classification", rollout, /LEGACY_SENDING[\s\S]*LEGACY_SYNCING[\s\S]*LEGACY_INERT[\s\S]*renderedSourceEpoch/u],
    ["server receipt handoff", activation, /(?=[\s\S]*record_application_readiness)(?=[\s\S]*receiptId)(?=[\s\S]*activate_application_contract)(?=[\s\S]*set_config\('app.activation_source')/u],
    ["admin activation surface", adminActivation, /activateApplicationContract\(\{ source: "ADMIN" \}\)/u],
    ["first cron activation surface", cronActivation, /siblingsSucceeded[\s\S]*activateApplicationContract\(\{ source: "FIRST_CRON" \}\)/u],
    ["post activation owner DML", rollout, /proveOwnerDmlContract[\s\S]*SET LOCAL app\.application_contract='discord-ops-v2'[\s\S]*OWNER_DML_CONTRACT_FAILED/u],
    ["old writer rejection", rollout, /postActivationMutationRejected[\s\S]*OLD_ARTIFACT_WRITE_ACCEPTED/u],
    ["operational readiness", readiness, /DISCORD_INTERACTIONS[\s\S]*DISCORD_RESERVATION_OUTBOX[\s\S]*retention[\s\S]*unready/u],
    ["portable QA lifecycle", operationalQa, /withOperationalPostgres[\s\S]*\["test"\][\s\S]*test:integration[\s\S]*\["run", "build"\][\s\S]*\["run", "vercel-build"\][\s\S]*runDiscordPhase[\s\S]*runBrowserPhase[\s\S]*snapshotGeneratedArtifacts/u],
    ["attempt-bound shared QA", operationalQa, /case "attempt"[\s\S]*validateAttemptIdentity[\s\S]*runPortableCore/u],
    ["explicit Playwright server", playwright, /E2E_BASE_URL is required[\s\S]*Desktop Chrome[\s\S]*workers:\s*1/u]
  ];
  for (const [label, source, pattern] of checks) {
    if (!pattern.test(source)) throw new OperationalStructureError(`Operational structure check failed: ${label}`);
  }
  const activationBody = functionBody(migration, "activate_application_contract");
  const exclusiveLock = activationBody.indexOf("pg_advisory_xact_lock(hashtextextended('discord-ops-v2-activation', 0))");
  const firstValidation = activationBody.indexOf('IF "expectedSource"');
  if (exclusiveLock < 0 || firstValidation < 0 || exclusiveLock > firstValidation) {
    throw new OperationalStructureError("Operational structure check failed: exclusive lock must precede activation validation");
  }
  const expectedIndexNames = [
    "User_name_trgm_idx", "User_studentNumber_trgm_idx", "AdminAction_action_trgm_idx",
    "AdminAction_reason_trgm_idx", "User_createdAt_id_idx",
    "Reservation_date_studyPeriod_createdAt_id_idx", "AdminAction_createdAt_id_idx"
  ] as const;
  const expectedIndexSql = [
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_name_trgm_idx" ON "public"."User" USING gin ("name" gin_trgm_ops)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_studentNumber_trgm_idx" ON "public"."User" USING gin ("studentNumber" gin_trgm_ops)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS "AdminAction_action_trgm_idx" ON "public"."AdminAction" USING gin ("action" gin_trgm_ops)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS "AdminAction_reason_trgm_idx" ON "public"."AdminAction" USING gin ("reason" gin_trgm_ops)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_createdAt_id_idx" ON "public"."User" USING btree ("createdAt" ASC, "id" ASC)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS "Reservation_date_studyPeriod_createdAt_id_idx" ON "public"."Reservation" USING btree ("date" ASC, "studyPeriod" ASC, "createdAt" ASC, "id" ASC)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS "AdminAction_createdAt_id_idx" ON "public"."AdminAction" USING btree ("createdAt" DESC, "id" DESC)'
  ] as const;
  if (ONLINE_INDEX_MANIFEST.length !== expectedIndexNames.length || ONLINE_INDEX_CHECKSUM.length !== 64 ||
      expectedIndexNames.some((name, index) => ONLINE_INDEX_MANIFEST[index]?.name !== name ||
        ONLINE_INDEX_MANIFEST[index]?.createSql !== expectedIndexSql[index])) {
    throw new OperationalStructureError("Operational structure check failed: exact seven-index manifest/checksum");
  }
  const expectedCore = "node scripts/verify-operational-fomo-evidence.mjs --mode core";
  const expectedAttempt = "node scripts/verify-operational-fomo-evidence.mjs --mode attempt";
  const exactCiCommand = "npm run qa:operational:core -- --phase full --ci";
  if (packageManifest.scripts?.["qa:operational:core"] !== expectedCore ||
      packageManifest.scripts?.["qa:operational"] !== expectedAttempt ||
      ci.split(exactCiCommand).length !== 2 || /^\s+services:/mu.test(ci) ||
      operationalQa.split('["run", "vercel-build"]').length !== 2) {
    throw new OperationalStructureError("Operational structure check failed: permanent single-core CI/package contract");
  }
  return checks.length + 3;

  function read(path: string): string {
    return readFileSync(join(root, ...path.split("/")), "utf8");
  }
}

function functionBody(migration: string, name: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION app_private.${name}`);
  const end = migration.indexOf("\n$$;", start);
  if (start < 0 || end < 0) throw new OperationalStructureError(`Operational function missing: ${name}`);
  return migration.slice(start, end);
}
