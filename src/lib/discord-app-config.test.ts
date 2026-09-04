import { describe, expect, it } from "vitest";

import { DiscordApplicationConfigError, parseDiscordApplicationConfig } from "./discord-app-config";

const completeConfig = {
  DISCORD_ADMIN_ROLE_ID: "123456789012345678",
  DISCORD_ADMIN_USER_MAP: " 223456789012345678 : 26001 , 323456789012345678:26002 ",
  DISCORD_APPLICATION_ID: "423456789012345678",
  DISCORD_BOT_TOKEN: "bot-token",
  DISCORD_CHANNEL_ID: "523456789012345678",
  DISCORD_GUILD_ID: "623456789012345678",
  DISCORD_PUBLIC_KEY: "a".repeat(64)
} as const;

describe("parseDiscordApplicationConfig", () => {
  it("returns null when every application interaction setting is absent", () => {
    // Given
    const raw = {} as const;

    // When
    const result = parseDiscordApplicationConfig(raw);

    // Then
    expect(result).toBeNull();
  });

  it("normalizes a complete application interaction configuration and user bindings", () => {
    // Given
    const raw = completeConfig;

    // When
    const result = parseDiscordApplicationConfig(raw);

    // Then
    expect(result).toEqual({
      adminRoleId: "123456789012345678",
      adminUserBindings: [
        { discordUserId: "223456789012345678", studentNumber: "26001" },
        { discordUserId: "323456789012345678", studentNumber: "26002" }
      ],
      applicationId: "423456789012345678",
      botToken: "bot-token",
      channelId: "523456789012345678",
      guildId: "623456789012345678",
      publicKey: "a".repeat(64)
    });
  });

  it("accepts a four-digit school student number in an administrator binding", () => {
    // Given
    const raw = {
      ...completeConfig,
      DISCORD_ADMIN_USER_MAP: "223456789012345678:2414"
    } as const;

    // When
    const result = parseDiscordApplicationConfig(raw);

    // Then
    expect(result?.adminUserBindings).toEqual([
      { discordUserId: "223456789012345678", studentNumber: "2414" }
    ]);
  });

  it.each(["development", "test", "production"] as const)(
    "rejects a partial application interaction configuration in %s",
    (nodeEnv) => {
      // Given
      const { DISCORD_CHANNEL_ID: _channelId, ...partialConfig } = completeConfig;

      // When / Then
      expect(() => parseDiscordApplicationConfig({ ...partialConfig, NODE_ENV: nodeEnv })).toThrow(
        new DiscordApplicationConfigError(["DISCORD_CHANNEL_ID"])
      );
    }
  );

  it("rejects invalid IDs, public keys, and student-number mappings using only key names", () => {
    // Given
    const raw = {
      ...completeConfig,
      DISCORD_ADMIN_USER_MAP: "223456789012345678:not-a-student-number",
      DISCORD_GUILD_ID: "not-a-snowflake",
      DISCORD_PUBLIC_KEY: "not-a-public-key"
    } as const;

    // When
    const parse = () => parseDiscordApplicationConfig(raw);

    // Then
    expect(parse).toThrow(new DiscordApplicationConfigError([
      "DISCORD_PUBLIC_KEY",
      "DISCORD_GUILD_ID",
      "DISCORD_ADMIN_USER_MAP"
    ]));
    expect(parse).not.toThrow("not-a-snowflake");
    expect(parse).not.toThrow("not-a-public-key");
    expect(parse).not.toThrow("not-a-student-number");
  });

  it("rejects duplicate Discord users and duplicate local student numbers", () => {
    // Given
    const raw = {
      ...completeConfig,
      DISCORD_ADMIN_USER_MAP: "223456789012345678:26001,223456789012345678:26002,323456789012345678:26001"
    } as const;

    // When / Then
    expect(() => parseDiscordApplicationConfig(raw)).toThrow(
      new DiscordApplicationConfigError(["DISCORD_ADMIN_USER_MAP"])
    );
  });
});
