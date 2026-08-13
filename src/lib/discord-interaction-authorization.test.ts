import { describe, expect, it } from "vitest";

import type { DiscordApplicationConfig } from "./discord-app-config";
import { authorizeCurrentDiscordReservationActor } from "./discord-interaction-authorization";

const config: DiscordApplicationConfig = {
  adminRoleId: "33333333333333333",
  adminUserBindings: [{ discordUserId: "44444444444444444", studentNumber: "12345" }],
  applicationId: "11111111111111111",
  botToken: "bot-token",
  channelId: "22222222222222222",
  guildId: "55555555555555555",
  publicKey: "a".repeat(64)
};

const source = {
  discordActorId: "44444444444444444",
  localActorId: "local-admin",
  sourceApplicationId: config.applicationId,
  sourceChannelId: config.channelId,
  sourceGuildId: config.guildId
} as const;

describe("current Discord reservation actor authorization", () => {
  it("authorizes only a currently mapped guild member with the current administrator role", () => {
    // Given / When
    const result = authorizeCurrentDiscordReservationActor({
      config,
      member: { kind: "found", roleIds: [config.adminRoleId] },
      source
    });

    // Then
    expect(result).toEqual({ kind: "authorized", studentNumber: "12345" });
  });

  it.each([
    ["removed mapping", { ...config, adminUserBindings: [] }, { kind: "found", roleIds: [config.adminRoleId] }, "unmapped_discord_user"],
    ["missing member", config, { kind: "missing" }, "guild_member_missing"],
    ["role downgrade", config, { kind: "found", roleIds: [] }, "missing_required_role"]
  ] as const)("returns stale for %s", (_label, currentConfig, member, code) => {
    // Given / When
    const result = authorizeCurrentDiscordReservationActor({ config: currentConfig, member, source });

    // Then
    expect(result).toEqual({ code, kind: "stale" });
  });

  it.each([
    [{ code: "discord_http_429", kind: "retryable_failure" }, "retryable_failure"],
    [{ code: "discord_http_500", kind: "retryable_failure" }, "retryable_failure"],
    [{ code: "discord_http_401", kind: "terminal_failure" }, "terminal_failure"]
  ] as const)("preserves live member lookup failure class", (member, kind) => {
    expect(authorizeCurrentDiscordReservationActor({ config, member, source })).toEqual({
      code: member.code,
      kind
    });
  });

  it("abandons a job whose persisted guild or channel no longer matches configuration", () => {
    expect(authorizeCurrentDiscordReservationActor({
      config,
      member: { kind: "found", roleIds: [config.adminRoleId] },
      source: { ...source, sourceChannelId: "99999999999999999" }
    })).toEqual({ code: "discord_config_mismatch", kind: "terminal_failure" });
  });

  it("abandons a job persisted for another Discord application", () => {
    expect(authorizeCurrentDiscordReservationActor({
      config,
      member: { kind: "found", roleIds: [config.adminRoleId] },
      source: { ...source, sourceApplicationId: "99999999999999999" }
    })).toEqual({ code: "discord_config_mismatch", kind: "terminal_failure" });
  });

  it("abandons an unbound legacy job", () => {
    expect(authorizeCurrentDiscordReservationActor({
      config,
      member: { kind: "found", roleIds: [config.adminRoleId] },
      source: { ...source, sourceApplicationId: null }
    })).toEqual({ code: "discord_config_mismatch", kind: "terminal_failure" });
  });
});
