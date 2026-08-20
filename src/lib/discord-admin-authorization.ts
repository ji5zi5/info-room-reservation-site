import type { DiscordApplicationConfig } from "./discord-app-config";
import type { DiscordAdminInteraction } from "./discord-admin-interaction-contracts";
import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";

type DiscordAdminSource = Exclude<DiscordAdminInteraction, { readonly kind: "invalid" }>;

export type DiscordAuthorizedAdmin = {
  readonly discordUserId: string;
  readonly id: string;
  readonly name: string;
  readonly role: "ADMIN";
  readonly studentNumber: string;
};

export type DiscordAdminAuthorizationResult =
  | { readonly actor: DiscordAuthorizedAdmin; readonly kind: "authorized" }
  | { readonly kind: "rejected" };

export async function authorizeDiscordAdminSource(input: {
  readonly config: DiscordApplicationConfig;
  readonly interaction: DiscordAdminSource;
}): Promise<DiscordAdminAuthorizationResult> {
  const { config, interaction } = input;
  if (
    interaction.applicationId !== config.applicationId || interaction.guildId !== config.guildId ||
    interaction.channelId !== config.channelId || !interaction.roleIds.includes(config.adminRoleId)
  ) return { kind: "rejected" };
  const binding = config.adminUserBindings.find(({ discordUserId }) => discordUserId === interaction.discordUserId);
  if (binding === undefined) return { kind: "rejected" };
  const actor = await withDatabaseContext({
    actor: systemDatabaseActor(),
    client: prisma,
    operation: (transaction) => transaction.user.findUnique({
      select: { id: true, name: true, role: true, studentNumber: true },
      where: { studentNumber: binding.studentNumber }
    })
  });
  return actor?.role === "ADMIN" && actor.studentNumber === binding.studentNumber
    ? { actor: { ...actor, discordUserId: interaction.discordUserId, role: "ADMIN" }, kind: "authorized" }
    : { kind: "rejected" };
}
