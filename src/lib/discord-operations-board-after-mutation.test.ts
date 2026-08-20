import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscordApplicationConfig } from "./discord-app-config";

const mocks = vi.hoisted(() => ({
  after: vi.fn<(callback: () => Promise<void>) => void>(),
  parseServerEnv: vi.fn(),
  requestSync: vi.fn(),
  syncBoard: vi.fn()
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("./env", () => ({ parseServerEnv: mocks.parseServerEnv }));
vi.mock("./prisma-discord-operations-board", () => ({ requestDiscordOperationsBoardSync: mocks.requestSync }));
vi.mock("./discord-operations-board-service", () => ({ syncDiscordOperationsBoard: mocks.syncBoard }));

import {
  scheduleDiscordOperationsBoardSync,
  syncDiscordOperationsBoardAfterMutation
} from "./discord-operations-board-after-mutation";

const config = {
  adminRoleId: "123456789012345678",
  adminUserBindings: [{ discordUserId: "223456789012345678", studentNumber: "31001" }],
  applicationId: "323456789012345678",
  botToken: "bot-token",
  channelId: "423456789012345678",
  guildId: "523456789012345678",
  publicKey: "a".repeat(64)
} satisfies DiscordApplicationConfig;

describe("Discord operations board mutation scheduling", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requestSync.mockResolvedValue(undefined);
    mocks.syncBoard.mockResolvedValue({ kind: "unchanged", messageId: "message-1" });
  });

  it("does not register deferred work when the Discord application is disabled", () => {
    // Given
    mocks.parseServerEnv.mockReturnValue({ discordApplication: null });

    // When
    scheduleDiscordOperationsBoardSync();

    // Then
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("marks the board pending before forcing an immediate synchronization", async () => {
    // Given
    const now = new Date("2026-08-20T06:00:00.000Z");

    // When
    await syncDiscordOperationsBoardAfterMutation(now, config);

    // Then
    expect(mocks.requestSync).toHaveBeenCalledWith(now);
    expect(mocks.syncBoard).toHaveBeenCalledWith({ config, force: true, now });
    expect(mocks.requestSync.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.syncBoard.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });
});
