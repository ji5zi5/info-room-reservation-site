import type { DiscordChannel, DiscordSetupSnapshot } from "./verify-discord-setup";

export type DiscordSetupFixtureMode = "everyone-admin" | "leaked-member" | "leaked-role" | "private";
type DiscordSetupFixture = DiscordSetupSnapshot & { readonly category: DiscordChannel };

const ids = {
  admin: "500000000000000002",
  adminRole: "500000000000000001",
  bot: "500000000000000003",
  botRole: "500000000000000004",
  category: "500000000000000007",
  channel: "500000000000000008",
  guild: "500000000000000000",
  administratorRole: "500000000000000005",
  outsider: "500000000000000009",
  outsiderRole: "500000000000000006",
  owner: "500000000000000012"
} as const;

export function createDiscordSetupFixture(mode: DiscordSetupFixtureMode): DiscordSetupFixture {
  const categoryOverwrites = [
    { allow: "0", deny: "93184", id: ids.guild, type: 0 as const },
    { allow: "1024", deny: "0", id: ids.adminRole, type: 0 as const },
    { allow: "93184", deny: "0", id: ids.botRole, type: 0 as const }
  ];
  const channelOverwrites = mode === "leaked-role"
    ? [...categoryOverwrites, { allow: "1024", deny: "0", id: ids.outsiderRole, type: 0 as const }]
    : mode === "leaked-member"
      ? [...categoryOverwrites, { allow: "1024", deny: "0", id: ids.outsider, type: 1 as const }]
      : categoryOverwrites;

  return {
    adminRoleId: mode === "everyone-admin" ? ids.guild : ids.adminRole,
    botMember: { roles: [ids.botRole], user: { id: ids.bot } },
    botUserId: ids.bot,
    category: {
      guildId: ids.guild,
      id: ids.category,
      parentId: null,
      permissionOverwrites: categoryOverwrites,
      type: 4
    },
    channel: {
      guildId: ids.guild,
      id: ids.channel,
      parentId: ids.category,
      permissionOverwrites: channelOverwrites,
      type: 0
    },
    explicitMembers: [
      { roles: [ids.adminRole], user: { id: ids.admin } },
      { roles: [ids.botRole], user: { id: ids.bot } },
      { roles: [], user: { id: ids.owner } },
      { roles: [ids.outsiderRole], user: { id: ids.outsider } }
    ],
    guild: { id: ids.guild, ownerId: ids.owner },
    mappedAdminUserIds: [ids.admin],
    registeredCommandNames: ["정보실"],
    roles: [
      { id: ids.guild, name: "@everyone", permissions: "1024" },
      { id: ids.adminRole, name: "operations", permissions: "0" },
      { id: ids.botRole, name: "app bot", permissions: "0", tags: { botId: ids.bot } },
      { id: ids.administratorRole, name: "administrator", permissions: "8" },
      { id: ids.outsiderRole, name: "outsider", permissions: "0" }
    ]
  };
}
