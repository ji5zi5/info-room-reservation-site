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

const PRISMA_MIGRATION_ROOT = join(process.cwd(), "prisma", "migrations");
const PRISMA_SCHEMA_PATH = join(process.cwd(), "prisma", "schema.prisma");

function readRlsMigration(): string {
  return readFileSync(RLS_MIGRATION_PATH, "utf8");
}

function readAllMigrations(): string {
  return readdirSync(PRISMA_MIGRATION_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readFileSync(join(PRISMA_MIGRATION_ROOT, entry.name, "migration.sql"), "utf8"))
    .join("\n");
}

function prismaTableNames(): readonly string[] {
  const schema = readFileSync(PRISMA_SCHEMA_PATH, "utf8");
  return Array.from(schema.matchAll(/^model\s+([A-Za-z][A-Za-z0-9_]*)\s+\{/gmu), (match) => match[1])
    .filter((name): name is string => name !== undefined);
}

describe("Postgres row level security policy migration", () => {
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
});
