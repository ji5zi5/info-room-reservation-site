import { describe, expect, it } from "vitest";

import {
  assertProductionEnvSafe,
  isLocalAdminLoginEnabled,
  isMockLoginEnabled,
  parseServerEnv
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
});
