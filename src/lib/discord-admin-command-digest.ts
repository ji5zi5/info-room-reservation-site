import { createHash } from "node:crypto";

export type DiscordAdminCommandIdentity = {
  readonly discordActorId: string;
  readonly draftIntent: string;
  readonly executionInteractionId: string | null;
  readonly ipHash: string;
  readonly localActorId: string;
  readonly reason: string | null;
  readonly sourceApplicationId: string;
  readonly sourceChannelId: string;
  readonly sourceGuildId: string;
  readonly sourceInteractionId: string;
};

export function buildDiscordAdminCommandDigest(identity: DiscordAdminCommandIdentity): string {
  const canonical = JSON.stringify({
    discordActorId: identity.discordActorId,
    draftIntent: identity.draftIntent,
    executionInteractionId: identity.executionInteractionId,
    ipHash: identity.ipHash,
    localActorId: identity.localActorId,
    reason: identity.reason,
    sourceApplicationId: identity.sourceApplicationId,
    sourceChannelId: identity.sourceChannelId,
    sourceGuildId: identity.sourceGuildId,
    sourceInteractionId: identity.sourceInteractionId
  });
  return `sha256:${createHash("sha256").update("discord-admin-command:v1\0").update(canonical).digest("hex")}`;
}
