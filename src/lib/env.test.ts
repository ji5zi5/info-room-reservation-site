import { describe, expect, it } from "vitest";

import {
  assertProductionEnvSafe,
  isLocalAdminLoginEnabled,
  isLocalStudentLoginEnabled,
  isMockLoginEnabled,
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
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
      ENABLE_PRODUCTION_LOCAL_STUDENT: "true",
      LOCAL_STUDENT_LOGIN_ID: "local-student",
      LOCAL_STUDENT_LOGIN_PASSWORD: "production-student-secret",
      NODE_ENV: "production",
      TRUST_FORWARDED_IP_HEADERS: "true"
    } as const;

    expect(() => assertProductionEnvSafe(productionEnv)).not.toThrow();
    expect(isLocalStudentLoginEnabled(productionEnv)).toBe(true);
    expect(isLocalAdminLoginEnabled(productionEnv)).toBe(false);
  });

  it("rejects a weak explicit production local student password", () => {
    expect(() =>
      assertProductionEnvSafe({
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
        ENABLE_PRODUCTION_LOCAL_STUDENT: "true",
        LOCAL_STUDENT_LOGIN_ID: "local_student_a",
        LOCAL_STUDENT_LOGIN_PASSWORD: "short",
        NODE_ENV: "production",
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
      CRON_SECRET: "cron-secret",
      DATABASE_URL: "postgresql://user:pass@example.test:5432/info_room",
      DIRECT_URL: "postgresql://user:pass@example.test:5432/info_room",
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
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
        ENABLE_PRODUCTION_LOCAL_STUDENT: "true",
        LOCAL_STUDENT_LOGIN_ID: "local_student_a,local_student_b",
        LOCAL_STUDENT_LOGIN_PASSWORD: "shared-secret",
        NODE_ENV: "production",
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
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
        ENABLE_PRODUCTION_LOCAL_STUDENT: "true",
        LOCAL_STUDENT_LOGIN_ID: "local_student_a,local_student_b",
        LOCAL_STUDENT_LOGIN_PASSWORD: "short,another-strong-secret",
        NODE_ENV: "production",
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
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
});
