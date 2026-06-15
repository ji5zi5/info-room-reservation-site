import { describe, expect, it } from "vitest";

import {
  assertProductionEnvSafe,
  isLocalAdminLoginEnabled,
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

  it("requires a Discord webhook in production", () => {
    expect(() => assertProductionEnvSafe({ DISCORD_WEBHOOK_URL: "", NODE_ENV: "production" })).toThrow(
      "DISCORD_WEBHOOK_URL"
    );
    expect(() => assertProductionEnvSafe({ NODE_ENV: "production" })).toThrow("DISCORD_WEBHOOK_URL");
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
