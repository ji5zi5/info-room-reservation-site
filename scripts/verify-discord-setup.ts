import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { HTTPError } from "ky";
import { z } from "zod";

import { DiscordApplicationConfigError } from "../src/lib/discord-app-config";
import { DiscordSetupCliError, loadLiveDiscordSetupSnapshot } from "./load-live-discord-setup";
import { createDiscordSetupFixture, type DiscordSetupFixtureMode } from "./verify-discord-setup.fixtures";

export const DISCORD_PERMISSIONS = {
  ADMINISTRATOR: 8n,
  EMBED_LINKS: 16_384n,
  MANAGE_MESSAGES: 8_192n,
  READ_MESSAGE_HISTORY: 65_536n,
  SEND_MESSAGES: 2_048n,
  VIEW_CHANNEL: 1_024n
} as const;

const requiredBotPermissions = ["VIEW_CHANNEL", "SEND_MESSAGES", "EMBED_LINKS", "READ_MESSAGE_HISTORY", "MANAGE_MESSAGES"] as const;
const decimalPattern = /^\d+$/u;
const snowflakePattern = /^[1-9]\d{16,19}$/u;

export type DiscordOverwrite = { readonly allow: string; readonly deny: string; readonly id: string; readonly type: 0 | 1 };
export type DiscordRole = {
  readonly id: string;
  readonly name: string;
  readonly permissions: string;
  readonly tags?: { readonly botId?: string };
};
export type DiscordMember = { readonly roles: readonly string[]; readonly user: { readonly id: string } };
export type DiscordChannel = {
  readonly guildId: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly permissionOverwrites: readonly DiscordOverwrite[];
  readonly type: number;
};
export type DiscordSetupSnapshot = {
  readonly adminRoleId: string;
  readonly botMember: DiscordMember;
  readonly botUserId: string;
  readonly category: DiscordChannel | null;
  readonly channel: DiscordChannel;
  readonly explicitMembers: readonly DiscordMember[];
  readonly guild: { readonly id: string; readonly ownerId: string };
  readonly mappedAdminUserIds: readonly string[];
  readonly registeredCommandNames: readonly string[];
  readonly roles: readonly DiscordRole[];
};
export type VerificationIssue =
  | { readonly code: "admin_role_cannot_view" | "admin_role_is_everyone" | "admin_role_missing" | "explicit_member_missing" | "leaked_member" | "leaked_role" | "mapped_admin_missing" | "mapped_admin_role_missing" | "malformed_data"; readonly subjectId: string }
  | { readonly code: "bot_permissions_missing"; readonly missingPermissions: readonly (typeof requiredBotPermissions)[number][] }
  | { readonly code: "command_missing"; readonly commandName: "정보실" };
export type VerificationResult = { readonly issues: readonly VerificationIssue[]; readonly ok: boolean };

function has(permissions: bigint, permission: bigint): boolean {
  return (permissions & permission) === permission;
}

function applyOverwrites(
  permissions: bigint,
  channel: DiscordChannel,
  guildId: string,
  roleIds: ReadonlySet<string>,
  memberId: string | null
): bigint {
  const everyone = channel.permissionOverwrites.find((entry) => entry.type === 0 && entry.id === guildId);
  let result = everyone ? (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow) : permissions;
  let deny = 0n;
  let allow = 0n;
  for (const overwrite of channel.permissionOverwrites) {
    if (overwrite.type === 0 && overwrite.id !== guildId && roleIds.has(overwrite.id)) {
      deny |= BigInt(overwrite.deny);
      allow |= BigInt(overwrite.allow);
    }
  }
  result = (result & ~deny) | allow;
  const member = memberId === null
    ? undefined
    : channel.permissionOverwrites.find((entry) => entry.type === 1 && entry.id === memberId);
  return member ? (result & ~BigInt(member.deny)) | BigInt(member.allow) : result;
}

function basePermissions(snapshot: DiscordSetupSnapshot, roleIds: ReadonlySet<string>): bigint {
  return snapshot.roles.reduce(
    (permissions, role) => role.id === snapshot.guild.id || roleIds.has(role.id)
      ? permissions | BigInt(role.permissions)
      : permissions,
    0n
  );
}

function effectivePermissions(snapshot: DiscordSetupSnapshot, roleIds: ReadonlySet<string>, memberId: string | null): bigint {
  const base = basePermissions(snapshot, roleIds);
  if (memberId === snapshot.guild.ownerId || has(base, DISCORD_PERMISSIONS.ADMINISTRATOR)) {
    return Object.values(DISCORD_PERMISSIONS).reduce((all, permission) => all | permission, 0n);
  }
  const inherited = snapshot.category ? applyOverwrites(base, snapshot.category, snapshot.guild.id, roleIds, memberId) : base;
  return applyOverwrites(inherited, snapshot.channel, snapshot.guild.id, roleIds, memberId);
}

export function computeEffectiveMemberPermissions(snapshot: DiscordSetupSnapshot, member: DiscordMember): bigint {
  return effectivePermissions(snapshot, new Set(member.roles), member.user.id);
}

function malformedSubject(snapshot: DiscordSetupSnapshot): string | null {
  const roleIds = new Set(snapshot.roles.map((role) => role.id));
  const overwrites = [...(snapshot.category?.permissionOverwrites ?? []), ...snapshot.channel.permissionOverwrites];
  const members = [...snapshot.explicitMembers, snapshot.botMember];
  const decimals = [...snapshot.roles.map((role) => role.permissions), ...overwrites.flatMap((entry) => [entry.allow, entry.deny])];
  if (snapshot.guild.id !== snapshot.channel.guildId || snapshot.channel.type === 4 ||
      (snapshot.channel.parentId === null ? snapshot.category !== null :
        snapshot.category?.id !== snapshot.channel.parentId || snapshot.category.guildId !== snapshot.guild.id || snapshot.category.type !== 4)) {
    return snapshot.channel.id;
  }
  if (new Set(snapshot.roles.map((role) => role.id)).size !== snapshot.roles.length ||
      new Set(snapshot.explicitMembers.map((member) => member.user.id)).size !== snapshot.explicitMembers.length ||
      decimals.some((value) => !decimalPattern.test(value))) {
    return snapshot.guild.id;
  }
  return overwrites.find((entry) => entry.type === 0 && !roleIds.has(entry.id))?.id
    ?? members.flatMap((member) => member.roles).find((id) => !roleIds.has(id))
    ?? null;
}

export function verifyDiscordSetup(snapshot: DiscordSetupSnapshot): VerificationResult {
  const issues: VerificationIssue[] = [];
  const malformed = malformedSubject(snapshot);
  if (malformed !== null) {
    return { issues: [{ code: "malformed_data", subjectId: malformed }], ok: false };
  }
  const everyoneRole = snapshot.roles.find((role) => role.id === snapshot.guild.id);
  const adminRole = snapshot.roles.find((role) => role.id === snapshot.adminRoleId);
  if (!everyoneRole) issues.push({ code: "malformed_data", subjectId: snapshot.guild.id });
  if (snapshot.adminRoleId === snapshot.guild.id) issues.push({ code: "admin_role_is_everyone", subjectId: snapshot.guild.id });
  if (!adminRole) issues.push({ code: "admin_role_missing", subjectId: snapshot.adminRoleId });
  if (adminRole && snapshot.adminRoleId !== snapshot.guild.id &&
      !has(effectivePermissions(snapshot, new Set([adminRole.id]), null), DISCORD_PERMISSIONS.VIEW_CHANNEL)) {
    issues.push({ code: "admin_role_cannot_view", subjectId: adminRole.id });
  }
  for (const role of snapshot.roles) {
    const roleIds = new Set(role.id === snapshot.guild.id ? [] : [role.id]);
    const base = basePermissions(snapshot, roleIds);
    const allowed = (role.id === snapshot.adminRoleId && snapshot.adminRoleId !== snapshot.guild.id) ||
      role.tags?.botId === snapshot.botUserId || has(base, DISCORD_PERMISSIONS.ADMINISTRATOR);
    if (!allowed && has(effectivePermissions(snapshot, roleIds, null), DISCORD_PERMISSIONS.VIEW_CHANNEL)) {
      issues.push({ code: "leaked_role", subjectId: role.id });
    }
  }
  const memberMap = new Map(snapshot.explicitMembers.map((member) => [member.user.id, member]));
  memberMap.set(snapshot.botMember.user.id, snapshot.botMember);
  for (const userId of snapshot.mappedAdminUserIds) {
    const member = memberMap.get(userId);
    if (!member) issues.push({ code: "mapped_admin_missing", subjectId: userId });
    else if (!member.roles.includes(snapshot.adminRoleId)) issues.push({ code: "mapped_admin_role_missing", subjectId: userId });
  }
  const explicitIds = new Set([...(snapshot.category?.permissionOverwrites ?? []), ...snapshot.channel.permissionOverwrites]
    .filter((entry) => entry.type === 1).map((entry) => entry.id));
  for (const userId of explicitIds) {
    const member = memberMap.get(userId);
    if (!member) {
      issues.push({ code: "explicit_member_missing", subjectId: userId });
      continue;
    }
    const base = basePermissions(snapshot, new Set(member.roles));
    const allowed = userId === snapshot.botUserId || userId === snapshot.guild.ownerId ||
      member.roles.includes(snapshot.adminRoleId) || has(base, DISCORD_PERMISSIONS.ADMINISTRATOR);
    if (!allowed && has(computeEffectiveMemberPermissions(snapshot, member), DISCORD_PERMISSIONS.VIEW_CHANNEL)) {
      issues.push({ code: "leaked_member", subjectId: userId });
    }
  }
  const botPermissions = computeEffectiveMemberPermissions(snapshot, snapshot.botMember);
  const missingPermissions = requiredBotPermissions.filter((name) => !has(botPermissions, DISCORD_PERMISSIONS[name]));
  if (snapshot.botMember.user.id !== snapshot.botUserId) issues.push({ code: "malformed_data", subjectId: snapshot.botUserId });
  if (missingPermissions.length > 0) issues.push({ code: "bot_permissions_missing", missingPermissions });
  if (!snapshot.registeredCommandNames.includes("정보실")) {
    issues.push({ code: "command_missing", commandName: "정보실" });
  }
  return { issues, ok: issues.length === 0 };
}

function fixtureMode(args: readonly string[]): DiscordSetupFixtureMode | null {
  if (args.length === 0) return null;
  if (args.length === 2 && args[0] === "--fixture" && isCliFixtureMode(args[1])) {
    return args[1];
  }
  throw new DiscordSetupCliError("Usage: verify-discord-setup [--fixture private|leaked-role|leaked-member]");
}

function isCliFixtureMode(value: string | undefined): value is Exclude<DiscordSetupFixtureMode, "everyone-admin"> {
  return value === "private" || value === "leaked-role" || value === "leaked-member";
}

async function runCli(): Promise<void> {
  try {
    const mode = fixtureMode(process.argv.slice(2));
    const result = verifyDiscordSetup(mode === null ? await loadLiveDiscordSetupSnapshot() : createDiscordSetupFixture(mode));
    if (!result.ok) {
      for (const issue of result.issues) console.error(JSON.stringify(issue));
      process.exitCode = 1;
      return;
    }
    console.log(`Discord private operations channel verification passed${mode === null ? "." : ` (${mode} fixture).`}`);
  } catch (error) { // no-excuse-ok: catch -- CLI boundary redacts credentials and untrusted response data.
    if (error instanceof DiscordSetupCliError || error instanceof DiscordApplicationConfigError) console.error(error.message);
    else if (error instanceof HTTPError) console.error(`Discord REST request failed with HTTP ${error.response.status}.`);
    else if (error instanceof z.ZodError) console.error("Discord REST returned malformed or incomplete setup data.");
    else console.error("Discord setup verification failed unexpectedly.");
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(resolve(entrypoint)).href === import.meta.url) void runCli();
