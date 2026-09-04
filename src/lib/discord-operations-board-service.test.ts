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
    const now = new Date("2026-08-20T05:00:00Z");
    const digest = (await import("./discord-operations-board-contracts")).discordOperationsBoardStateDigest(snapshot, now);
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
    const result = await sync({ bot, config, force: false, now });

    // Then: only the ledger heartbeat changes.
    expect(result.kind).toBe("unchanged");
    expect(bot.editChannelMessage).not.toHaveBeenCalled();
    expect(completeUnchanged).toHaveBeenCalledOnce();
  });

  it("updates the pinned message when the board presentation version changes", async () => {
    const snapshot = boardSnapshot();
    const previousDigest = `sha256:${createHash("sha256")
      .update("discord-operations-board:v4\0")
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

  it("edits the pinned message on a forced refresh even within the same minute", async () => {
    // Given: a matching board digest and an explicit refresh request.
    const snapshot = boardSnapshot();
    const now = new Date("2026-08-20T05:00:30Z");
    const digest = (await import("./discord-operations-board-contracts")).discordOperationsBoardStateDigest(snapshot, now);
    const complete = vi.fn().mockResolvedValue(true);
    const bot = {
      createChannelMessage: vi.fn(),
      deleteChannelMessage: vi.fn(),
      editChannelMessage: vi.fn().mockResolvedValue({ kind: "sent", messageId: claim.messageId })
    };
    const sync = createDiscordOperationsBoardService({
      claim: vi.fn().mockResolvedValue({ ...claim, stateDigest: digest }),
      complete,
      completeUnchanged: vi.fn(),
      fail: vi.fn(),
      loadSnapshot: vi.fn().mockResolvedValue(snapshot),
      pin: vi.fn()
    });

    // When: an operator presses refresh.
    const result = await sync({ bot, config, force: true, now });

    // Then: Discord receives a real message edit with the fresh timestamp.
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

  it("recreates and pins the board when the stored Discord message was deleted", async () => {
    // Given: Discord reports that the previously stored message no longer exists.
    const complete = vi.fn().mockResolvedValue(true);
    const pin = vi.fn().mockResolvedValue({ kind: "pinned" });
    const bot = {
      createChannelMessage: vi.fn().mockResolvedValue({ kind: "sent", messageId: "12345678901234599" }),
      deleteChannelMessage: vi.fn(),
      editChannelMessage: vi.fn().mockResolvedValue({
        code: "discord_http_404",
        kind: "failed",
        message: "missing",
        outcome: "FAILED"
      })
    };
    const sync = createDiscordOperationsBoardService({
      claim: vi.fn().mockResolvedValue(claim),
      complete,
      completeUnchanged: vi.fn(),
      fail: vi.fn(),
      loadSnapshot: vi.fn().mockResolvedValue(boardSnapshot()),
      pin
    });

    // When: the next scheduled synchronization runs.
    const result = await sync({ bot, config, force: false, now: new Date("2026-08-20T05:00:00Z") });

    // Then: a replacement is created, pinned, and stored automatically.
    expect(result).toEqual({ kind: "recreated", messageId: "12345678901234599" });
    expect(bot.createChannelMessage).toHaveBeenCalledOnce();
    expect(pin).toHaveBeenCalledWith(expect.objectContaining({ messageId: "12345678901234599" }));
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ messageId: "12345678901234599" }));
  });

  it("records an unexpected snapshot failure instead of leaving the board claim locked", async () => {
    // Given: the database snapshot read fails after a claim is acquired.
    const failure = Object.assign(new Error("snapshot unavailable"), { name: "SnapshotLoadError" });
    const fail = vi.fn().mockResolvedValue(undefined);
    const sync = createDiscordOperationsBoardService({
      claim: vi.fn().mockResolvedValue(claim),
      complete: vi.fn(),
      completeUnchanged: vi.fn(),
      fail,
      loadSnapshot: vi.fn().mockRejectedValue(failure),
      pin: vi.fn()
    });
    const bot = { createChannelMessage: vi.fn(), deleteChannelMessage: vi.fn(), editChannelMessage: vi.fn() };

    // When: synchronization runs.
    const result = await sync({ bot, config, force: false, now: new Date("2026-08-20T05:00:00Z") });

    // Then: the claim becomes retryable immediately with a bounded error code.
    expect(result).toEqual({ code: "SnapshotLoadError", kind: "failed" });
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "SnapshotLoadError" }));
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
