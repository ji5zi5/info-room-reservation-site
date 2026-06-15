import { describe, expect, it } from "vitest";

import { extractSessionCookie, parseSmokeEnv, SmokeConfigError } from "../../scripts/external-smoke";

describe("external smoke config", () => {
  it("parses the required Riro smoke configuration without enabling Discord send", () => {
    const config = parseSmokeEnv({
      RIRO_SMOKE_ID: "25-00000",
      RIRO_SMOKE_PASSWORD: "password",
      SMOKE_BASE_URL: "https://example.com/"
    });

    expect(config).toEqual({
      adminSend: null,
      baseUrl: "https://example.com",
      riro: { id: "25-00000", password: "password" }
    });
  });

  it("treats blank optional smoke variables as unset", () => {
    const config = parseSmokeEnv({
      RIRO_SMOKE_ID: "25-00000",
      RIRO_SMOKE_PASSWORD: "password",
      SMOKE_ADMIN_ID: "",
      SMOKE_ADMIN_PASSWORD: "",
      SMOKE_BASE_URL: "https://example.com",
      SMOKE_CLOSED_LIST_DATE: "",
      SMOKE_CLOSED_LIST_PERIOD: "",
      SMOKE_CONFIRM_DISCORD_SEND: "",
      SMOKE_FORCE_DISCORD_SEND: ""
    });

    expect(config.adminSend).toBeNull();
  });

  it("does not configure Discord send when confirmation is explicitly false", () => {
    const config = parseSmokeEnv({
      RIRO_SMOKE_ID: "25-00000",
      RIRO_SMOKE_PASSWORD: "password",
      SMOKE_BASE_URL: "https://example.com",
      SMOKE_CONFIRM_DISCORD_SEND: "false"
    });

    expect(config.adminSend).toBeNull();
  });

  it("requires an explicit confirmation before configuring a Discord send", () => {
    expect(() =>
      parseSmokeEnv({
        RIRO_SMOKE_ID: "25-00000",
        RIRO_SMOKE_PASSWORD: "password",
        SMOKE_ADMIN_ID: "admin",
        SMOKE_ADMIN_PASSWORD: "password",
        SMOKE_BASE_URL: "https://example.com",
        SMOKE_CLOSED_LIST_DATE: "2026-06-15",
        SMOKE_CLOSED_LIST_PERIOD: "EIGHTH"
      })
    ).toThrow(SmokeConfigError);
  });

  it("configures Discord send only after explicit confirmation", () => {
    const config = parseSmokeEnv({
      RIRO_SMOKE_ID: "25-00000",
      RIRO_SMOKE_PASSWORD: "password",
      SMOKE_ADMIN_ID: "admin",
      SMOKE_ADMIN_PASSWORD: "password",
      SMOKE_BASE_URL: "https://example.com",
      SMOKE_CLOSED_LIST_DATE: "2026-06-15",
      SMOKE_CLOSED_LIST_PERIOD: "EIGHTH",
      SMOKE_CONFIRM_DISCORD_SEND: "true",
      SMOKE_FORCE_DISCORD_SEND: "false"
    });

    expect(config.adminSend).toEqual({
      credentials: { id: "admin", password: "password" },
      date: "2026-06-15",
      force: false,
      studyPeriod: "EIGHTH"
    });
  });

  it("extracts the app session cookie from a combined Set-Cookie header", () => {
    expect(extractSessionCookie("theme=light; Path=/, info_room_session=session-token; Path=/; HttpOnly")).toBe(
      "info_room_session=session-token"
    );
  });
});
