import ky from "ky";
import { z } from "zod";

import { parseDiscordApplicationConfig } from "../src/lib/discord-app-config";
import type {
  DiscordChannel,
  DiscordMember,
  DiscordRole,
  DiscordSetupSnapshot
} from "./verify-discord-setup";

const decimalPattern = /^\d+$/u;
const snowflakePattern = /^[1-9]\d{16,19}$/u;
const PermissionSchema = z.string().regex(decimalPattern);
const OverwriteSchema = z.object({
  allow: PermissionSchema,
  deny: PermissionSchema,
  id: z.string().regex(snowflakePattern),
  type: z.union([z.literal(0), z.literal(1)])
});
const MemberSchema = z.object({
  roles: z.array(z.string().regex(snowflakePattern)),
  user: z.object({ id: z.string().regex(snowflakePattern) })
}).transform((member): DiscordMember => ({ roles: member.roles, user: member.user }));
const RoleSchema = z.object({
  id: z.string().regex(snowflakePattern),
  name: z.string(),
  permissions: PermissionSchema,
  tags: z.object({ bot_id: z.string().regex(snowflakePattern).optional() }).optional()
}).transform((role): DiscordRole => role.tags?.bot_id
  ? { id: role.id, name: role.name, permissions: role.permissions, tags: { botId: role.tags.bot_id } }
  : { id: role.id, name: role.name, permissions: role.permissions });
const ChannelSchema = z.object({
  guild_id: z.string().regex(snowflakePattern),
  id: z.string().regex(snowflakePattern),
  parent_id: z.string().regex(snowflakePattern).nullable(),
  permission_overwrites: z.array(OverwriteSchema),
  type: z.number().int()
}).transform((channel): DiscordChannel => ({
  guildId: channel.guild_id,
  id: channel.id,
  parentId: channel.parent_id,
  permissionOverwrites: channel.permission_overwrites,
  type: channel.type
}));
const GuildSchema = z.object({ id: z.string().regex(snowflakePattern), owner_id: z.string().regex(snowflakePattern) });
const CommandsSchema = z.array(z.object({ name: z.string().min(1) }));

export class DiscordSetupCliError extends Error {}

export async function loadLiveDiscordSetupSnapshot(): Promise<DiscordSetupSnapshot> {
  const config = parseDiscordApplicationConfig(process.env);
  if (config === null) throw new DiscordSetupCliError("Complete Discord application environment is required.");
  const api = ky.create({
    headers: { Authorization: `Bot ${config.botToken}` },
    prefixUrl: "https://discord.com/api/v10",
    retry: { limit: 2, methods: ["get"], statusCodes: [408, 429, 500, 502, 503, 504] },
    timeout: 5_000
  });
  const get = async (path: string): Promise<unknown> => api.get(path).json<unknown>();
  const [guildRaw, rolesRaw, channelRaw, commandsRaw] = await Promise.all([
    get(`guilds/${config.guildId}`),
    get(`guilds/${config.guildId}/roles`),
    get(`channels/${config.channelId}`),
    get(`applications/${config.applicationId}/guilds/${config.guildId}/commands`)
  ]);
  const guild = GuildSchema.parse(guildRaw);
  const roles = z.array(RoleSchema).parse(rolesRaw);
  const channel = ChannelSchema.parse(channelRaw);
  const registeredCommandNames = CommandsSchema.parse(commandsRaw).map((command) => command.name);
  if (guild.id !== config.guildId || channel.id !== config.channelId) {
    throw new DiscordSetupCliError("Configured Discord guild or channel did not resolve.");
  }
  const category = channel.parentId === null ? null : ChannelSchema.parse(await get(`channels/${channel.parentId}`));
  const explicitIds = [...(category?.permissionOverwrites ?? []), ...channel.permissionOverwrites]
    .filter((entry) => entry.type === 1)
    .map((entry) => entry.id);
  const memberIds = [...new Set([
    config.applicationId,
    ...config.adminUserBindings.map((binding) => binding.discordUserId),
    ...explicitIds
  ])];
  const members = await Promise.all(memberIds.map(async (id) =>
    MemberSchema.parse(await get(`guilds/${config.guildId}/members/${id}`))
  ));
  const botMember = members.find((member) => member.user.id === config.applicationId);
  if (!botMember) throw new DiscordSetupCliError("Discord bot guild member did not resolve.");
  return {
    adminRoleId: config.adminRoleId,
    botMember,
    botUserId: config.applicationId,
    category,
    channel,
    explicitMembers: members,
    guild: { id: guild.id, ownerId: guild.owner_id },
    mappedAdminUserIds: config.adminUserBindings.map((binding) => binding.discordUserId),
    registeredCommandNames,
    roles
  };
}
