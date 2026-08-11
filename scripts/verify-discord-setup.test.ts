import { describe, expect, it } from "vitest";

import { createDiscordSetupFixture } from "./verify-discord-setup.fixtures";
import {
  DISCORD_PERMISSIONS,
  computeEffectiveMemberPermissions,
  verifyDiscordSetup,
  type DiscordChannel,
  type DiscordMember,
  type DiscordSetupSnapshot
} from "./verify-discord-setup";

function replaceChannel(
  snapshot: DiscordSetupSnapshot,
  channel: DiscordChannel
): DiscordSetupSnapshot {
  return { ...snapshot, channel };
}

function replaceMember(
  snapshot: DiscordSetupSnapshot,
  member: DiscordMember
): DiscordSetupSnapshot {
  return {
    ...snapshot,
    explicitMembers: snapshot.explicitMembers.map((candidate) =>
      candidate.user.id === member.user.id ? member : candidate
    )
  };
}

describe("verifyDiscordSetup", () => {
  it("accepts the private fixture with inherited category deny and operations allows", () => {
    // Given
    const snapshot = createDiscordSetupFixture("private");

    // When
    const result = verifyDiscordSetup(snapshot);

    // Then
    expect(result).toEqual({ issues: [], ok: true });
  });

  it("rejects a channel role allow that overrides an inherited category deny", () => {
    // Given
    const snapshot = createDiscordSetupFixture("leaked-role");

    // When
    const result = verifyDiscordSetup(snapshot);

    // Then
    expect(result.issues).toContainEqual({ code: "leaked_role", subjectId: "500000000000000006" });
  });

  it("uses the target channel overwrite after it de-syncs from a category allow", () => {
    // Given
    const base = createDiscordSetupFixture("private");
    const outsiderRoleId = "500000000000000006";
    const outsider = base.explicitMembers.find((member) => member.user.id === "500000000000000009");
    expect(outsider).toBeDefined();
    const snapshot = replaceChannel(
      { ...base, category: {
        ...base.category,
        permissionOverwrites: [
          ...base.category.permissionOverwrites,
          { allow: "1024", deny: "0", id: outsiderRoleId, type: 0 }
        ]
      } },
      {
        ...base.channel,
        permissionOverwrites: [
          ...base.channel.permissionOverwrites,
          { allow: "0", deny: "1024", id: outsiderRoleId, type: 0 }
        ]
      }
    );

    // When
    const permissions = computeEffectiveMemberPermissions(snapshot, outsider ?? base.botMember);

    // Then
    expect(permissions & DISCORD_PERMISSIONS.VIEW_CHANNEL).toBe(0n);
  });

  it("combines role overwrites so an allow wins over a deny at the same level", () => {
    // Given
    const base = createDiscordSetupFixture("private");
    const outsider = base.explicitMembers.find((member) => member.user.id === "500000000000000009");
    expect(outsider).toBeDefined();
    const allowRoleId = "500000000000000010";
    const member = { ...(outsider ?? base.botMember), roles: ["500000000000000006", allowRoleId] };
    const snapshot = replaceMember(
      replaceChannel(
        {
          ...base,
          roles: [...base.roles, { id: allowRoleId, name: "allow", permissions: "0" }]
        },
        {
          ...base.channel,
          permissionOverwrites: [
            ...base.channel.permissionOverwrites,
            { allow: "0", deny: "1024", id: "500000000000000006", type: 0 },
            { allow: "1024", deny: "0", id: allowRoleId, type: 0 }
          ]
        }
      ),
      member
    );

    // When
    const permissions = computeEffectiveMemberPermissions(snapshot, member);

    // Then
    expect(permissions & DISCORD_PERMISSIONS.VIEW_CHANNEL).toBe(DISCORD_PERMISSIONS.VIEW_CHANNEL);
  });

  it("applies an explicit member deny after a role allow", () => {
    // Given
    const snapshot = createDiscordSetupFixture("private");
    const mappedAdmin = snapshot.explicitMembers.find((member) => member.user.id === snapshot.mappedAdminUserIds[0]);
    expect(mappedAdmin).toBeDefined();
    const channel = {
      ...snapshot.channel,
      permissionOverwrites: [
        ...snapshot.channel.permissionOverwrites,
        { allow: "0", deny: "1024", id: mappedAdmin?.user.id ?? snapshot.guild.ownerId, type: 1 as const }
      ]
    };

    // When
    const permissions = computeEffectiveMemberPermissions(replaceChannel(snapshot, channel), mappedAdmin ?? snapshot.botMember);

    // Then
    expect(permissions & DISCORD_PERMISSIONS.VIEW_CHANNEL).toBe(0n);
  });

  it("rejects an explicit outsider member allow after role and everyone denies", () => {
    // Given
    const snapshot = createDiscordSetupFixture("leaked-member");

    // When
    const result = verifyDiscordSetup(snapshot);

    // Then
    expect(result.issues).toContainEqual({ code: "leaked_member", subjectId: "500000000000000009" });
  });

  it("keeps the guild owner effective permissions despite every overwrite deny", () => {
    // Given
    const snapshot = createDiscordSetupFixture("private");
    const owner = snapshot.explicitMembers.find((member) => member.user.id === snapshot.guild.ownerId);
    expect(owner).toBeDefined();

    // When
    const permissions = computeEffectiveMemberPermissions(snapshot, owner ?? snapshot.botMember);

    // Then
    expect(permissions & DISCORD_PERMISSIONS.VIEW_CHANNEL).toBe(DISCORD_PERMISSIONS.VIEW_CHANNEL);
  });

  it("allows an unavoidable administrator role despite channel denies", () => {
    // Given
    const snapshot = createDiscordSetupFixture("private");

    // When
    const result = verifyDiscordSetup(snapshot);

    // Then
    expect(result.issues).not.toContainEqual({ code: "leaked_role", subjectId: "500000000000000005" });
  });

  it("requires every mapped admin member to resolve and carry the configured role", () => {
    // Given
    const base = createDiscordSetupFixture("private");
    const missing = { ...base, mappedAdminUserIds: [...base.mappedAdminUserIds, "500000000000000011"] };
    const mappedId = base.mappedAdminUserIds[0] ?? base.guild.ownerId;
    const withoutRole = {
      ...base,
      explicitMembers: base.explicitMembers.map((member) =>
        member.user.id === mappedId ? { ...member, roles: [] } : member
      )
    };

    // When
    const missingResult = verifyDiscordSetup(missing);
    const roleResult = verifyDiscordSetup(withoutRole);

    // Then
    expect(missingResult.issues).toContainEqual({ code: "mapped_admin_missing", subjectId: "500000000000000011" });
    expect(roleResult.issues).toContainEqual({ code: "mapped_admin_role_missing", subjectId: mappedId });
  });

  it("rejects the everyone role as the configured operations admin role", () => {
    // Given
    const snapshot = createDiscordSetupFixture("everyone-admin");

    // When
    const result = verifyDiscordSetup(snapshot);

    // Then
    expect(result.issues).toContainEqual({ code: "admin_role_is_everyone", subjectId: snapshot.guild.id });
  });

  it("requires all four bot channel permissions", () => {
    // Given
    const base = createDiscordSetupFixture("private");
    const snapshot = {
      ...base,
      category: {
        ...base.category,
        permissionOverwrites: base.category.permissionOverwrites.map((overwrite) =>
          overwrite.id === "500000000000000004"
            ? { ...overwrite, allow: (BigInt(overwrite.allow) & ~DISCORD_PERMISSIONS.EMBED_LINKS).toString() }
            : overwrite
        )
      },
      channel: {
        ...base.channel,
        permissionOverwrites: base.channel.permissionOverwrites.map((overwrite) =>
          overwrite.id === "500000000000000004"
            ? { ...overwrite, allow: (BigInt(overwrite.allow) & ~DISCORD_PERMISSIONS.EMBED_LINKS).toString() }
            : overwrite
        )
      }
    };

    // When
    const result = verifyDiscordSetup(snapshot);

    // Then
    expect(result.issues).toContainEqual({ code: "bot_permissions_missing", missingPermissions: ["EMBED_LINKS"] });
  });
});
