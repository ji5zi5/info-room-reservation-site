import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createDiscordOperationsBoardService, type DiscordOperationsBoardClaim } from "./discord-operations-board-service";

const claim: DiscordOperationsBoardClaim = {
  attempts: 1,
  channelId: "12345678901234568",
  claimId: "claim-1",
  guildId: "12345678901234569",
  messageId: "12345678901234570",
  renderedDate: "2026-08-20",
  revision: 3,
  stateDigest: "sha256:old"
};
const config = {
  adminRoleId: "12345678901234571",
  adminUserBindings: [{ discordUserId: "12345678901234572", studentNumber: "31001" }],
  applicationId: "12345678901234567",
  botToken: "bot-token",
  channelId: "12345678901234568",
  guildId: "12345678901234569",
  publicKey: "a".repeat(64)
};

describe("Discord operations board service", () => {
  it("does not edit the pinned message when the board state digest is unchanged", async () => {
    // Given: an existing board whose rendered state matches the current snapshot.
    const snapshot = boardSnapshot();
    const digest = (await import("./discord-operations-board-contracts")).discordOperationsBoardStateDigest(snapshot);
    const completeUnchanged = vi.fn().mockResolvedValue(true);
    const bot = { createChannelMessage: vi.fn(), deleteChannelMessage: vi.fn(), editChannelMessage: vi.fn() };
    const sync = createDiscordOperationsBoardService({
      claim: vi.fn().mockResolvedValue({ ...claim, stateDigest: digest }),
      complete: vi.fn(),
      completeUnchanged,
      fail: vi.fn(),
      loadSnapshot: vi.fn().mockResolvedValue(snapshot),
      pin: vi.fn()
    });

    // When: the one-minute synchronization runs.
    const result = await sync({ bot, config, force: false, now: new Date("2026-08-20T05:00:00Z") });

    // Then: only the ledger heartbeat changes.
    expect(result.kind).toBe("unchanged");
    expect(bot.editChannelMessage).not.toHaveBeenCalled();
    expect(completeUnchanged).toHaveBeenCalledOnce();
  });

  it("updates the pinned message when the board presentation version changes", async () => {
    const snapshot = boardSnapshot();
    const previousDigest = `sha256:${createHash("sha256")
      .update("discord-operations-board:v3\0")
      .update(JSON.stringify(snapshot))
      .digest("hex")}`;
    const bot = {
      createChannelMessage: vi.fn(),
      deleteChannelMessage: vi.fn(),
      editChannelMessage: vi.fn().mockResolvedValue({ kind: "sent", messageId: claim.messageId })
    };
    const complete = vi.fn().mockResolvedValue(true);
    const sync = createDiscordOperationsBoardService({
      claim: vi.fn().mockResolvedValue({ ...claim, stateDigest: previousDigest }),
      complete,
      completeUnchanged: vi.fn(),
      fail: vi.fn(),
      loadSnapshot: vi.fn().mockResolvedValue(snapshot),
      pin: vi.fn()
    });

    const result = await sync({ bot, config, force: false, now: new Date("2026-08-20T05:00:00Z") });

    expect(result).toEqual({ kind: "updated", messageId: claim.messageId });
    expect(bot.editChannelMessage).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
  });

  it("creates and pins the board when no configured message exists", async () => {
    // Given: a claimed board without a Discord message.
    const complete = vi.fn().mockResolvedValue(true);
    const pin = vi.fn().mockResolvedValue({ kind: "pinned" });
    const bot = {
      createChannelMessage: vi.fn().mockResolvedValue({ kind: "sent", messageId: "12345678901234580" }),
      deleteChannelMessage: vi.fn(),
      editChannelMessage: vi.fn()
    };
    const sync = createDiscordOperationsBoardService({
      claim: vi.fn().mockResolvedValue({ ...claim, channelId: null, guildId: null, messageId: null }),
      complete,
      completeUnchanged: vi.fn(),
      fail: vi.fn(),
      loadSnapshot: vi.fn().mockResolvedValue(boardSnapshot()),
      pin
    });

    // When: synchronization runs.
    const result = await sync({ bot, config, force: false, now: new Date("2026-08-20T05:00:00Z") });

    // Then: the message is created, pinned, and recorded.
    expect(result).toEqual({ kind: "created", messageId: "12345678901234580" });
    expect(pin).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 }));
  });

  it("removes a newly created board when pinning fails", async () => {
    // Given: Discord accepts the message but rejects the pin request.
    const fail = vi.fn().mockResolvedValue(undefined);
    const bot = {
      createChannelMessage: vi.fn().mockResolvedValue({ kind: "sent", messageId: "12345678901234580" }),
      deleteChannelMessage: vi.fn().mockResolvedValue({ kind: "removed" }),
      editChannelMessage: vi.fn()
    };
    const sync = createDiscordOperationsBoardService({
      claim: vi.fn().mockResolvedValue({ ...claim, channelId: null, guildId: null, messageId: null }),
      complete: vi.fn(),
      completeUnchanged: vi.fn(),
      fail,
      loadSnapshot: vi.fn().mockResolvedValue(boardSnapshot()),
      pin: vi.fn().mockResolvedValue({ code: "discord_pin_forbidden", kind: "failed" })
    });

    // When
    const result = await sync({ bot, config, force: false, now: new Date("2026-08-20T05:00:00Z") });

    // Then: retry state remains durable without leaving an orphan board message.
    expect(result).toEqual({ code: "discord_pin_forbidden", kind: "failed" });
    expect(bot.deleteChannelMessage).toHaveBeenCalledWith({
      channelId: config.channelId,
      messageId: "12345678901234580"
    });
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "discord_pin_forbidden" }));
  });
});

function boardSnapshot() {
  return {
    adminCommandBacklog: 0,
    closedNotificationsEnabled: true,
    date: "2026-08-20",
    interactionBacklog: 0,
    lastProcessedAt: null,
    operationalJobs: [],
    periods: [],
    reservationNotificationsEnabled: true,
    recentErrorCount: 0,
    unresolvedDeliveries: 0
  };
}
