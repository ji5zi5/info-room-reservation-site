import { describe, expect, it } from "vitest";

import {
  assertProductionEnvSafe,
  isLocalAdminLoginEnabled,
  isLocalStudentLoginEnabled,
  isMockLoginEnabled,
  isRetentionPurgeEnabled,
  parseServerEnv,
  shouldTrustForwardedIpHeaders
} from "./env";

describe("server environment guards", () => {
  it("rejects mock login in production", () => {
    expect(() =>
      assertProductionEnvSafe({
        NODE_ENV: "production",
        RIRO_MOCK_LOGIN: "true"
      })
    ).toThrow("RIRO_MOCK_LOGIN");
  });

  it("rejects local admin login in production", () => {
    expect(() =>
      assertProductionEnvSafe({
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
        ENABLE_LOCAL_ADMIN: "true",
        NODE_ENV: "production",
        TRUST_FORWARDED_IP_HEADERS: "true"
      })
    ).toThrow("ENABLE_LOCAL_ADMIN");
  });

  it("rejects local student login in production", () => {
    expect(() =>
      assertProductionEnvSafe({
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
        ENABLE_LOCAL_STUDENT: "true",
        NODE_ENV: "production",
        TRUST_FORWARDED_IP_HEADERS: "true"
      })
    ).toThrow("ENABLE_LOCAL_STUDENT");
  });

  it("allows an explicit production local student fallback without the generic local toggle", () => {
    const productionEnv = {
      ADMIN_STUDENT_NUMBERS: "test-admin-student",
      CLOSED_PERIOD_CRON_SECRET: "closed-period-secret-with-enough-length",
      DATABASE_URL: "postgresql://user:pass@example.test:6543/info_room",
      DIRECT_URL: "postgresql://user:pass@example.test:5432/info_room",
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
      ENABLE_PRODUCTION_LOCAL_STUDENT: "true",
      LOCAL_STUDENT_LOGIN_ID: "local-student",
      LOCAL_STUDENT_LOGIN_PASSWORD: "production-student-secret",
      MAINTENANCE_CRON_SECRET: "maintenance-secret-with-enough-length",
      NODE_ENV: "production",
      SESSION_SECRET: "session-secret-with-enough-length",
      TRUST_FORWARDED_IP_HEADERS: "true"
    } as const;

    expect(() => assertProductionEnvSafe(productionEnv)).not.toThrow();
    expect(isLocalStudentLoginEnabled(productionEnv)).toBe(true);
    expect(isLocalAdminLoginEnabled(productionEnv)).toBe(false);
  });

  it("rejects a production local student number that overlaps the admin allowlist", () => {
    // Given
    const productionEnv = {
      ADMIN_STUDENT_NUMBERS: "91001",
      CLOSED_PERIOD_CRON_SECRET: "closed-period-secret-with-enough-length",
      DATABASE_URL: "postgresql://user:pass@example.test:6543/info_room",
      DIRECT_URL: "postgresql://user:pass@example.test:5432/info_room",
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
      ENABLE_PRODUCTION_LOCAL_STUDENT: "true",
      LOCAL_STUDENT_LOGIN_ID: "local-student",
      LOCAL_STUDENT_LOGIN_PASSWORD: "production-student-secret",
      LOCAL_STUDENT_NUMBER: "91001",
      MAINTENANCE_CRON_SECRET: "maintenance-secret-with-enough-length",
      NODE_ENV: "production",
      SESSION_SECRET: "session-secret-with-enough-length",
      TRUST_FORWARDED_IP_HEADERS: "true"
    } as const;

    // When / Then
    expect(() => assertProductionEnvSafe(productionEnv)).toThrow("ADMIN_STUDENT_NUMBERS");
  });

  it("rejects a weak explicit production local student password", () => {
    expect(() =>
      assertProductionEnvSafe({
        ADMIN_STUDENT_NUMBERS: "test-admin-student",
        CLOSED_PERIOD_CRON_SECRET: "closed-period-secret-with-enough-length",
        DATABASE_URL: "postgresql://user:pass@example.test:6543/info_room",
        DIRECT_URL: "postgresql://user:pass@example.test:5432/info_room",
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
        ENABLE_PRODUCTION_LOCAL_STUDENT: "true",
        LOCAL_STUDENT_LOGIN_ID: "local_student_a",
        LOCAL_STUDENT_LOGIN_PASSWORD: "short",
        MAINTENANCE_CRON_SECRET: "maintenance-secret-with-enough-length",
        NODE_ENV: "production",
        SESSION_SECRET: "session-secret-with-enough-length",
        TRUST_FORWARDED_IP_HEADERS: "true"
      })
    ).toThrow("LOCAL_STUDENT_LOGIN_PASSWORD");
  });

  it("requires a Discord webhook in production", () => {
    expect(() => assertProductionEnvSafe({ DISCORD_WEBHOOK_URL: "", NODE_ENV: "production" })).toThrow(
      "DISCORD_WEBHOOK_URL"
    );
    expect(() => assertProductionEnvSafe({ NODE_ENV: "production" })).toThrow("DISCORD_WEBHOOK_URL");
  });

  it("rejects non-Discord webhook URLs in production", () => {
    expect(() =>
      assertProductionEnvSafe({
        DISCORD_WEBHOOK_URL: "https://example.test/api/webhooks/1/token",
        NODE_ENV: "production",
        TRUST_FORWARDED_IP_HEADERS: "true"
      })
    ).toThrow("DISCORD_WEBHOOK_URL");
  });

  it("requires trusted forwarded IP headers in production", () => {
    const productionEnv = {
      ADMIN_STUDENT_NUMBERS: "test-admin-student",
      CLOSED_PERIOD_CRON_SECRET: "closed-period-secret-with-enough-length",
      DATABASE_URL: "postgresql://user:pass@example.test:5432/info_room",
      DIRECT_URL: "postgresql://user:pass@example.test:5432/info_room",
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
      MAINTENANCE_CRON_SECRET: "maintenance-secret-with-enough-length",
      NODE_ENV: "production",
      RIRO_MOCK_LOGIN: "false",
      SESSION_SECRET: "session-secret-with-enough-length"
    } as const;

    expect(() => assertProductionEnvSafe(productionEnv)).toThrow("TRUST_FORWARDED_IP_HEADERS");
    expect(() =>
      assertProductionEnvSafe({ ...productionEnv, TRUST_FORWARDED_IP_HEADERS: "false" })
    ).toThrow("TRUST_FORWARDED_IP_HEADERS");
    expect(() =>
      assertProductionEnvSafe({ ...productionEnv, TRUST_FORWARDED_IP_HEADERS: "true" })
    ).not.toThrow();
  });

  it("requires all production deployment secrets at the runtime guard boundary", () => {
    const baseProductionEnv = {
      ADMIN_STUDENT_NUMBERS: "test-admin-student",
      CLOSED_PERIOD_CRON_SECRET: "closed-period-secret-with-enough-length",
      DATABASE_URL: "postgresql://user:pass@example.test:6543/info_room",
      DIRECT_URL: "postgresql://user:pass@example.test:5432/info_room",
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
      MAINTENANCE_CRON_SECRET: "maintenance-secret-with-enough-length",
      NODE_ENV: "production",
      SESSION_SECRET: "session-secret-with-enough-length",
      TRUST_FORWARDED_IP_HEADERS: "true"
    } as const;

    expect(() => assertProductionEnvSafe(baseProductionEnv)).not.toThrow();
    expect(() => assertProductionEnvSafe({ ...baseProductionEnv, DATABASE_URL: "" })).toThrow("DATABASE_URL");
    expect(() => assertProductionEnvSafe({ ...baseProductionEnv, DIRECT_URL: "" })).toThrow("DIRECT_URL");
    expect(() => assertProductionEnvSafe({ ...baseProductionEnv, SESSION_SECRET: "" })).toThrow("SESSION_SECRET");
    expect(() => assertProductionEnvSafe({ ...baseProductionEnv, ADMIN_STUDENT_NUMBERS: "" })).toThrow(
      "ADMIN_STUDENT_NUMBERS"
    );
    expect(() => assertProductionEnvSafe({ ...baseProductionEnv, CLOSED_PERIOD_CRON_SECRET: "" })).toThrow(
      "CLOSED_PERIOD_CRON_SECRET"
    );
    expect(() => assertProductionEnvSafe({ ...baseProductionEnv, MAINTENANCE_CRON_SECRET: "" })).toThrow(
      "MAINTENANCE_CRON_SECRET"
    );
  });

  it("rejects weak production shared secrets", () => {
    const baseProductionEnv = {
      ADMIN_STUDENT_NUMBERS: "test-admin-student",
      CLOSED_PERIOD_CRON_SECRET: "closed-period-secret-with-enough-length",
      DATABASE_URL: "postgresql://user:pass@example.test:6543/info_room",
      DIRECT_URL: "postgresql://user:pass@example.test:5432/info_room",
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
      MAINTENANCE_CRON_SECRET: "maintenance-secret-with-enough-length",
      NODE_ENV: "production",
      SESSION_SECRET: "session-secret-with-enough-length",
      TRUST_FORWARDED_IP_HEADERS: "true"
    } as const;

    expect(() => assertProductionEnvSafe({ ...baseProductionEnv, SESSION_SECRET: "short" })).toThrow(
      "SESSION_SECRET"
    );
    expect(() => assertProductionEnvSafe({ ...baseProductionEnv, CLOSED_PERIOD_CRON_SECRET: "short" })).toThrow(
      "CLOSED_PERIOD_CRON_SECRET"
    );
    expect(() => assertProductionEnvSafe({ ...baseProductionEnv, MAINTENANCE_CRON_SECRET: "short" })).toThrow(
      "MAINTENANCE_CRON_SECRET"
    );
  });

  it("requires separate scoped cron secrets and rejects the legacy shared secret", () => {
    const productionEnv = {
      ADMIN_STUDENT_NUMBERS: "test-admin-student",
      CLOSED_PERIOD_CRON_SECRET: "closed-period-secret-with-enough-length",
      DATABASE_URL: "postgresql://user:pass@example.test:6543/info_room",
      DIRECT_URL: "postgresql://user:pass@example.test:5432/info_room",
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
      MAINTENANCE_CRON_SECRET: "maintenance-secret-with-enough-length",
      NODE_ENV: "production",
      SESSION_SECRET: "session-secret-with-enough-length",
      TRUST_FORWARDED_IP_HEADERS: "true"
    } as const;

    expect(() => assertProductionEnvSafe(productionEnv)).not.toThrow();
    expect(() => assertProductionEnvSafe({ ...productionEnv, CLOSED_PERIOD_CRON_SECRET: "" })).toThrow(
      "CLOSED_PERIOD_CRON_SECRET"
    );
    expect(() => assertProductionEnvSafe({ ...productionEnv, MAINTENANCE_CRON_SECRET: "" })).toThrow(
      "MAINTENANCE_CRON_SECRET"
    );
    expect(() =>
      assertProductionEnvSafe({ ...productionEnv, CRON_SECRET: "legacy-shared-secret-with-enough-length" })
    ).toThrow("CRON_SECRET");
  });

  it("enables mock login only in non-production no-database mode", () => {
    expect(isMockLoginEnabled({ NODE_ENV: "development", RIRO_MOCK_LOGIN: "true", DATABASE_URL: "" })).toBe(true);
    expect(
      isMockLoginEnabled({
        DATABASE_URL: "postgresql://user:pass@example.test:5432/info_room",
        NODE_ENV: "development",
        RIRO_MOCK_LOGIN: "true"
      })
    ).toBe(false);
  });

  it("does not enable the local admin account through mock login", () => {
    expect(isLocalAdminLoginEnabled({ ENABLE_LOCAL_ADMIN: "false", RIRO_MOCK_LOGIN: "true" })).toBe(false);
    expect(isLocalAdminLoginEnabled({ ENABLE_LOCAL_ADMIN: "true", RIRO_MOCK_LOGIN: "false" })).toBe(true);
  });

  it("does not enable the local student account through mock login", () => {
    expect(isLocalStudentLoginEnabled({ ENABLE_LOCAL_STUDENT: "false", RIRO_MOCK_LOGIN: "true" })).toBe(false);
    expect(
      isLocalStudentLoginEnabled({
        ENABLE_LOCAL_STUDENT: "true",
        LOCAL_STUDENT_LOGIN_ID: "site-student",
        LOCAL_STUDENT_LOGIN_PASSWORD: "local-student-secret",
        RIRO_MOCK_LOGIN: "false"
      })
    ).toBe(true);
  });

  it("rejects a weak local student password when student fallback is enabled", () => {
    expect(() =>
      assertProductionEnvSafe({
        ENABLE_LOCAL_STUDENT: "true",
        LOCAL_STUDENT_LOGIN_ID: "site-student",
        LOCAL_STUDENT_LOGIN_PASSWORD: "short"
      })
    ).toThrow("LOCAL_STUDENT_LOGIN_PASSWORD");
  });

  it("allows multiple local student fallback ids with a shared strong password", () => {
    expect(() =>
      assertProductionEnvSafe({
        ADMIN_STUDENT_NUMBERS: "test-admin-student",
        CLOSED_PERIOD_CRON_SECRET: "closed-period-secret-with-enough-length",
        DATABASE_URL: "postgresql://user:pass@example.test:6543/info_room",
        DIRECT_URL: "postgresql://user:pass@example.test:5432/info_room",
        ENABLE_PRODUCTION_LOCAL_STUDENT: "true",
        LOCAL_STUDENT_LOGIN_ID: "local_student_a,local_student_b",
        LOCAL_STUDENT_LOGIN_PASSWORD: "shared-secret",
        MAINTENANCE_CRON_SECRET: "maintenance-secret-with-enough-length",
        NODE_ENV: "production",
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
        SESSION_SECRET: "session-secret-with-enough-length",
        TRUST_FORWARDED_IP_HEADERS: "true"
      })
    ).not.toThrow();
  });

  it("rejects overlapping local admin and student fallback ids", () => {
    expect(() =>
      assertProductionEnvSafe({
        ADMIN_LOGIN_ID: "local_student_a",
        ADMIN_LOGIN_PASSWORD: "local-admin-secret",
        ENABLE_LOCAL_ADMIN: "true",
        ENABLE_LOCAL_STUDENT: "true",
        LOCAL_STUDENT_LOGIN_ID: "local_student_a,local_student_b",
        LOCAL_STUDENT_LOGIN_PASSWORD: "shared-secret"
      })
    ).toThrow("ADMIN_LOGIN_ID");
  });

  it("rejects any weak password in a multiple local student fallback list", () => {
    expect(() =>
      assertProductionEnvSafe({
        ADMIN_STUDENT_NUMBERS: "test-admin-student",
        CLOSED_PERIOD_CRON_SECRET: "closed-period-secret-with-enough-length",
        DATABASE_URL: "postgresql://user:pass@example.test:6543/info_room",
        DIRECT_URL: "postgresql://user:pass@example.test:5432/info_room",
        ENABLE_PRODUCTION_LOCAL_STUDENT: "true",
        LOCAL_STUDENT_LOGIN_ID: "local_student_a,local_student_b",
        LOCAL_STUDENT_LOGIN_PASSWORD: "short,another-strong-secret",
        MAINTENANCE_CRON_SECRET: "maintenance-secret-with-enough-length",
        NODE_ENV: "production",
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
        SESSION_SECRET: "session-secret-with-enough-length",
        TRUST_FORWARDED_IP_HEADERS: "true"
      })
    ).toThrow("LOCAL_STUDENT_LOGIN_PASSWORD");
  });

  it("validates a configured Discord webhook URL", () => {
    expect(() => parseServerEnv({ DISCORD_WEBHOOK_URL: "not-a-url" })).toThrow("DISCORD_WEBHOOK_URL");
  });

  it("parses a direct database URL for Prisma migrations", () => {
    expect(
      parseServerEnv({
        DATABASE_URL: "postgresql://user:pass@pooler.example.test:6543/info_room",
        DIRECT_URL: "postgresql://user:pass@db.example.test:5432/info_room"
      })
    ).toMatchObject({
      databaseUrl: "postgresql://user:pass@pooler.example.test:6543/info_room",
      directUrl: "postgresql://user:pass@db.example.test:5432/info_room"
    });
  });

  it("rejects invalid forwarded IP trust flag values", () => {
    expect(() => parseServerEnv({ TRUST_FORWARDED_IP_HEADERS: "yes" })).toThrow("TRUST_FORWARDED_IP_HEADERS");
  });

  it("trusts forwarded IP headers only when explicitly enabled", () => {
    expect(shouldTrustForwardedIpHeaders({})).toBe(false);
    expect(shouldTrustForwardedIpHeaders({ TRUST_FORWARDED_IP_HEADERS: "false" })).toBe(false);
    expect(shouldTrustForwardedIpHeaders({ TRUST_FORWARDED_IP_HEADERS: "true" })).toBe(true);
  });

  it("enables destructive retention only through its explicit flag", () => {
    expect(isRetentionPurgeEnabled({})).toBe(false);
    expect(isRetentionPurgeEnabled({ RETENTION_PURGE_ENABLED: "false" })).toBe(false);
    expect(isRetentionPurgeEnabled({ RETENTION_PURGE_ENABLED: "true" })).toBe(true);
    expect(() => parseServerEnv({ RETENTION_PURGE_ENABLED: "yes" })).toThrow("RETENTION_PURGE_ENABLED");
  });
});
