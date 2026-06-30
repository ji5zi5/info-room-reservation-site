import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RLS_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260630150000_add_rls_policies",
  "migration.sql"
);

const RLS_TABLES = [
  "AdminAction",
  "AuditLog",
  "CsrfToken",
  "NotificationDelivery",
  "PeriodSetting",
  "RateLimitBucket",
  "Reservation",
  "Session",
  "User",
  "UserSanction"
] as const;

function readRlsMigration(): string {
  return readFileSync(RLS_MIGRATION_PATH, "utf8");
}

describe("Postgres row level security policy migration", () => {
  it("uses app session settings instead of Supabase Auth JWT helpers", () => {
    const sql = readRlsMigration();

    expect(sql).toContain("current_setting('app.current_user_id', true)");
    expect(sql).toContain("current_setting('app.current_user_role', true)");
    expect(sql).not.toContain("auth.uid()");
    expect(sql).not.toMatch(/FORCE\s+ROW\s+LEVEL\s+SECURITY/iu);
  });

  it("enables RLS on user-owned and operational tables", () => {
    const sql = readRlsMigration();

    for (const tableName of RLS_TABLES) {
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
});
