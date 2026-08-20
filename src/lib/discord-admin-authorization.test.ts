import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock("./db", () => ({ prisma: {} }));
vi.mock("./db-context", () => ({
  systemDatabaseActor: () => ({ kind: "SYSTEM" }),
  withDatabaseContext: ({ operation }: { readonly operation: (transaction: unknown) => unknown }) =>
    operation({ user: { findUnique: mocks.findUnique } })
}));

import { authorizeDiscordAdminSource } from "./discord-admin-authorization";

const config = {
  adminRoleId: "12345678901234571",
  adminUserBindings: [{ discordUserId: "12345678901234572", studentNumber: "31001" }],
  applicationId: "12345678901234567",
  botToken: "bot-token",
  channelId: "12345678901234568",
  guildId: "12345678901234569",
  publicKey: "a".repeat(64)
};
const mappedDiscordUserId = "12345678901234572";
const interaction = {
  applicationId: config.applicationId,
  channelId: config.channelId,
  discordUserId: mappedDiscordUserId,
  guildId: config.guildId,
  interactionId: "12345678901234570",
  interactionToken: "token",
  intent: { kind: "operations_status" as const },
  kind: "command" as const,
  roleIds: [config.adminRoleId]
};

describe("Discord administrator authorization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findUnique.mockResolvedValue({ id: "admin-1", name: "관리자", role: "ADMIN", studentNumber: "31001" });
  });

  it.each([
    ["application", { applicationId: "12345678901234999" }],
    ["guild", { guildId: "12345678901234999" }],
    ["channel", { channelId: "12345678901234999" }],
    ["role", { roleIds: [] }],
    ["mapping", { discordUserId: "12345678901234999" }]
  ] as const)("rejects a mismatched %s before reading administrator data", async (_label, patch) => {
    const result = await authorizeDiscordAdminSource({ config, interaction: { ...interaction, ...patch } });

    expect(result).toEqual({ kind: "rejected" });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("authorizes only the mapped local administrator", async () => {
    await expect(authorizeDiscordAdminSource({ config, interaction })).resolves.toMatchObject({
      actor: { discordUserId: interaction.discordUserId, id: "admin-1", role: "ADMIN", studentNumber: "31001" },
      kind: "authorized"
    });
  });
});
