import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RLS_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260630150000_add_rls_policies",
  "migration.sql"
);

const RETENTION_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260724010000_add_retention_policy",
  "migration.sql"
);

const DISCORD_OPERATIONS_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260811010000_add_discord_reservation_operations",
  "migration.sql"
);

const DISCORD_V2_MIGRATION_PATH = join(
  process.cwd(), "prisma", "migrations",
  "20260811150000_add_discord_ops_v2_foundations", "migration.sql"
);

const DISCORD_APPLICATION_BINDING_MIGRATION_PATH = join(
  process.cwd(), "prisma", "migrations",
  "20260813103000_bind_discord_interaction_application", "migration.sql"
);

const PRISMA_MIGRATION_ROOT = join(process.cwd(), "prisma", "migrations");
const PRISMA_SCHEMA_PATH = join(process.cwd(), "prisma", "schema.prisma");
const BAD_RUNTIME_ROLE_MIGRATION = "20260729060000_add_limited_runtime_role";
const CORRECTIVE_RUNTIME_ROLE_MIGRATION =
  "20260810010000_drop_unconditional_runtime_policies";

function readRlsMigration(): string {
  return readFileSync(RLS_MIGRATION_PATH, "utf8");
}

function readAllMigrations(): string {
  return readdirSync(PRISMA_MIGRATION_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readFileSync(join(PRISMA_MIGRATION_ROOT, entry.name, "migration.sql"), "utf8"))
    .join("\n");
}

function orderedMigrations(): readonly { readonly name: string; readonly sql: string }[] {
  return readdirSync(PRISMA_MIGRATION_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(PRISMA_MIGRATION_ROOT, name, "migration.sql"), "utf8")
    }));
}

function prismaTableNames(): readonly string[] {
  const schema = readFileSync(PRISMA_SCHEMA_PATH, "utf8");
  return Array.from(schema.matchAll(/^model\s+([A-Za-z][A-Za-z0-9_]*)\s+\{/gmu), (match) => match[1])
    .filter((name): name is string => name !== undefined);
}

describe("Postgres row level security policy migration", () => {
  it("expands Discord application binding as nullable and gates readiness and activation", () => {
    const schema = readFileSync(PRISMA_SCHEMA_PATH, "utf8");
    const sql = readFileSync(DISCORD_APPLICATION_BINDING_MIGRATION_PATH, "utf8");

    expect(schema).toMatch(/sourceApplicationId\s+String\?/u);
    expect(sql).toMatch(/^BEGIN;/u);
    expect(sql).toMatch(/COMMIT;\s*$/u);
    expect(sql).toContain("discord operations v2 schema contract is required");
    expect(sql).toContain('ADD COLUMN "sourceApplicationId" TEXT;');
    expect(sql).not.toMatch(/"sourceApplicationId"\s+TEXT\s+NOT NULL/iu);
    expect(sql).toContain("WHERE \"sourceApplicationId\" IS NULL");
    expect(sql).toContain("AND \"status\" IN ('PENDING', 'PROCESSING', 'RETRY')");
    expect(sql).toContain("set_config('app.current_user_role', 'SYSTEM', true)");
    expect(sql).toContain('CREATE TRIGGER "ApplicationDeploymentReceipt_bound_interaction_jobs"');
    expect(sql).toContain('CREATE TRIGGER "DiscordOperationsControl_bound_interaction_jobs"');
    expect(sql).toContain('ALTER TABLE "DiscordInteractionJob" FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain('OLD."sourceApplicationId"');
    expect(sql).toContain('NEW."sourceApplicationId"');
    expect(sql).toMatch(
      /ALTER FUNCTION app_private\.require_bound_discord_interaction_jobs\(\)\s+OWNER TO info_room_activation_owner;/u
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION app_private\.require_bound_discord_interaction_jobs\(\)\s+FROM PUBLIC, info_room_runtime;/u
    );
    expect(sql).toContain('GRANT SELECT ON TABLE "DiscordInteractionJob" TO info_room_activation_owner;');
    expect(sql).toContain('CREATE POLICY "discord_interaction_job_admin_system_all"');
    expect(sql.indexOf('CREATE TRIGGER "ApplicationDeploymentReceipt_bound_interaction_jobs"'))
      .toBeLessThan(sql.indexOf("ALTER FUNCTION app_private.require_bound_discord_interaction_jobs()"));
  });

  it("adds forced-RLS Discord v2 foundations with owner-only activation state", () => {
    const sql = readFileSync(DISCORD_V2_MIGRATION_PATH, "utf8");
    for (const table of ["DiscordInteractionJob", "DiscordOperationsControl", "SchemaCompatibility", "ApplicationDeploymentReceipt"]) {
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
    }
    expect(sql).toContain("CREATE TABLE app_private.online_schema_migrations");
    expect(sql).toContain("app_private.record_application_readiness");
    expect(sql).toContain("app_private.activate_application_contract");
    expect(sql).toContain("app_private.require_application_contract");
    expect(sql).toMatch(/CREATE ROLE info_room_activation_owner[\s\S]*?NOLOGIN[\s\S]*?NOSUPERUSER[\s\S]*?NOBYPASSRLS/iu);
    expect(sql).toMatch(/CREATE ROLE info_room_activation_executor[\s\S]*?LOGIN[\s\S]*?NOSUPERUSER[\s\S]*?NOBYPASSRLS/iu);
    expect(sql).toContain("GRANT info_room_activation_owner TO CURRENT_USER;");
    expect(sql.indexOf("GRANT info_room_activation_owner TO CURRENT_USER;")).toBeLessThan(
      sql.indexOf("ALTER FUNCTION app_private.record_application_readiness")
    );
    expect(sql).toContain("GRANT USAGE, CREATE ON SCHEMA app_private TO info_room_activation_owner;");
    expect(sql.indexOf("GRANT USAGE, CREATE ON SCHEMA app_private TO info_room_activation_owner;")).toBeLessThan(
      sql.indexOf("ALTER FUNCTION app_private.record_application_readiness")
    );
    expect(sql).toContain("ALTER FUNCTION app_private.record_application_readiness(text, text, text) OWNER TO info_room_activation_owner;");
    expect(sql).toContain("ALTER FUNCTION app_private.activate_application_contract(text, text, text) OWNER TO info_room_activation_owner;");
    expect(sql).toContain('CREATE POLICY "application_deployment_receipt_activation_insert"');
    expect(sql).toContain('CREATE POLICY "application_deployment_receipt_activation_update"');
    expect(sql).toContain('CREATE POLICY "schema_compatibility_activation_update"');
    expect(sql).toContain('CREATE POLICY "discord_operations_control_activation_update"');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE "ApplicationDeploymentReceipt" TO info_room_activation_owner;');
    expect(sql).toContain('GRANT SELECT, UPDATE ON TABLE "SchemaCompatibility", "DiscordOperationsControl" TO info_room_activation_owner;');
    expect(sql).toContain("REVOKE ALL ON FUNCTION app_private.record_application_readiness(text, text, text) FROM PUBLIC, info_room_runtime;");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION app_private.record_application_readiness(text, text, text) TO info_room_activation_executor;");
    expect(sql).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE).*(ApplicationDeploymentReceipt|SchemaCompatibility|online_schema_migrations).*info_room_runtime/iu);
  });

  it("uses app session settings instead of Supabase Auth JWT helpers", () => {
    const sql = readRlsMigration();

    expect(sql).toContain("current_setting('app.current_user_id', true)");
    expect(sql).toContain("current_setting('app.current_user_role', true)");
    expect(sql).not.toContain("auth.uid()");
    expect(sql).not.toMatch(/FORCE\s+ROW\s+LEVEL\s+SECURITY/iu);
  });

  it("enables RLS on every Prisma and migration metadata table", () => {
    const sql = readAllMigrations();

    for (const tableName of [...prismaTableNames(), "_prisma_migrations"]) {
      expect(sql).toContain(`ALTER TABLE "${tableName}" ENABLE ROW LEVEL SECURITY;`);
    }
  });

  it("keeps student data policies scoped to the current actor or admin/system roles", () => {
    const sql = readRlsMigration();

    expect(sql).toContain('app_private.can_access_user("id")');
    expect(sql).toContain('app_private.can_access_user("userId")');
    expect(sql).toContain("app_private.is_admin_or_system()");
    expect(sql).toContain("app_private.is_system()");
  });

  it("restricts retention policy access to admin and system roles", () => {
    const sql = readFileSync(RETENTION_MIGRATION_PATH, "utf8");

    expect(sql).toContain('ALTER TABLE "RetentionPolicy" ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('CREATE POLICY "retention_policy_admin_system_all"');
    expect(sql).toContain("app_private.is_admin_or_system()");
  });

  it("grants runtime CRUD access to Discord ledgers behind ADMIN/SYSTEM RLS", () => {
    const sql = readFileSync(DISCORD_OPERATIONS_MIGRATION_PATH, "utf8");

    for (const table of ["DiscordReservationMessage", "DiscordInteractionReceipt"]) {
      expect(sql).toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO info_room_runtime;`
      );
    }
    expect(sql.match(/USING \(app_private\.is_admin_or_system\(\)\)/gu)).toHaveLength(2);
    expect(sql).not.toContain(
      "GRANT EXECUTE ON FUNCTION app_private.bump_discord_reservation_message_revision() TO info_room_runtime;"
    );
  });

  it("removes every unconditional runtime policy in a later additive migration", () => {
    const migrations = orderedMigrations();
    const badMigrationIndex = migrations.findIndex(({ name }) => name === BAD_RUNTIME_ROLE_MIGRATION);
    const badMigration = migrations[badMigrationIndex];

    expect(badMigrationIndex).toBeGreaterThanOrEqual(0);
    expect(badMigration).toBeDefined();

    const runtimePolicies = Array.from(
      badMigration?.sql.matchAll(
        /CREATE POLICY\s+"([^"]+_runtime_all)"\s+ON\s+"([^"]+)"\s+FOR ALL TO info_room_runtime USING \(true\) WITH CHECK \(true\);/gmu
      ) ?? [],
      (match) => ({ policy: match[1], table: match[2] })
    );

    expect(runtimePolicies).toHaveLength(13);

    const expectedDrops = runtimePolicies.map(
      ({ policy, table }) => `DROP POLICY IF EXISTS "${policy}" ON "${table}"`
    );
    const correction = migrations.slice(badMigrationIndex + 1).find(({ sql }) =>
      expectedDrops.every((drop) => sql.includes(`${drop};`))
    );

    expect(correction?.name.localeCompare(BAD_RUNTIME_ROLE_MIGRATION)).toBeGreaterThan(0);
    expect(
      correction?.sql
        .split(";")
        .map((statement) => statement.trim())
        .filter((statement) => statement.startsWith("DROP POLICY"))
    ).toEqual(expectedDrops);
  });

  it("rejects an unsafe runtime role without requiring managed-database role alteration", () => {
    const correction = orderedMigrations().find(
      ({ name }) => name === CORRECTIVE_RUNTIME_ROLE_MIGRATION
    );

    expect(correction?.sql).toContain("info_room_runtime role has unsafe privileges");
    expect(correction?.sql).toMatch(
      /rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls/mu
    );
    expect(correction?.sql).not.toContain("ALTER ROLE info_room_runtime");
  });

  it("does not recreate unconditional runtime policies after the flawed migration", () => {
    const migrations = orderedMigrations();
    const badMigrationIndex = migrations.findIndex(({ name }) => name === BAD_RUNTIME_ROLE_MIGRATION);
    const laterSql = migrations
      .slice(badMigrationIndex + 1)
      .map(({ sql }) => sql)
      .join("\n");

    expect(badMigrationIndex).toBeGreaterThanOrEqual(0);
    expect(laterSql).not.toMatch(
      /CREATE\s+POLICY\s+(?:"[^"]+_runtime_all"|[A-Za-z_][A-Za-z0-9_]*_runtime_all)\s+ON\b/imu
    );
  });

  it("does not weaken RLS or grant BYPASSRLS in later migrations", () => {
    const migrations = orderedMigrations();
    const badMigrationIndex = migrations.findIndex(({ name }) => name === BAD_RUNTIME_ROLE_MIGRATION);
    const laterSql = migrations
      .slice(badMigrationIndex + 1)
      .map(({ sql }) => sql)
      .join("\n");

    expect(badMigrationIndex).toBeGreaterThanOrEqual(0);
    expect(laterSql).not.toMatch(/(?<!NO)\bBYPASSRLS\b/imu);
    expect(laterSql).not.toMatch(/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/imu);
  });
});
