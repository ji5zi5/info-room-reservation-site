import { describe, expect, it, vi } from "vitest";

import {
  createDiscordReservationRetention,
  type DiscordRetentionCandidate,
  type DiscordRetentionRepository
} from "./discord-reservation-retention";
import type { DiscordBotClient, DiscordBotDeleteResult } from "./discord-bot";

const now = new Date("2026-08-11T00:00:00.000Z");
const botCandidate = {
  channelId: "channel",
  expiresAt: new Date("2026-08-10T00:00:00.000Z"),
  messageId: "message",
  reservationId: "reservation",
  updatedAt: new Date("2026-08-10T00:00:00.000Z")
};

describe("Discord reservation retention", () => {
  it("deletes a bot message remotely before conditionally deleting its ledger row", async () => {
    // Given: an expired terminal bot-authored message.
    const events: string[] = [];
    const { bot, repository } = dependencies([botCandidate], events);

    // When: one retention batch runs.
    const result = await createDiscordReservationRetention({ bot, hasApplicationConfig: () => true, repository })(now);

    // Then: remote removal precedes the guarded ledger delete.
    expect(result).toEqual({ hasMore: false, processedCount: 1, remainingLowerBound: 0 });
    expect(events).toEqual(["remote:message", "local:reservation"]);
  });

  it.each([
    { code: "discord_http_429", kind: "failed", message: "rate limited" },
    { code: "discord_http_500", kind: "failed", message: "server failed" },
    { code: "discord_http_401", kind: "failed", message: "unauthorized" },
    { code: "discord_http_403", kind: "failed", message: "forbidden" }
  ] satisfies readonly DiscordBotDeleteResult[])("retains the ledger pointer when Discord returns $code", async (failure) => {
    // Given: an expired message whose remote deletion fails.
    const { bot, repository } = dependencies([botCandidate]);
    vi.mocked(bot.deleteChannelMessage).mockResolvedValue(failure);

    // When: retention runs.
    const result = await createDiscordReservationRetention({ bot, hasApplicationConfig: () => true, repository })(now);

    // Then: no local delete occurs and backlog is surfaced.
    expect(result).toEqual({ hasMore: false, processedCount: 0, remainingLowerBound: 1 });
    expect(repository.deleteExpiredCandidate).not.toHaveBeenCalled();
  });

  it("retains bot pointers without app config while deleting terminal webhook-only rows locally", async () => {
    // Given: one bot row and one terminal row without a Discord message id.
    const localCandidate: DiscordRetentionCandidate = {
      ...botCandidate,
      channelId: null,
      messageId: null,
      reservationId: "webhook-only"
    };
    const { bot, repository } = dependencies([botCandidate, localCandidate]);

    // When: retention runs without complete Discord app configuration.
    const result = await createDiscordReservationRetention({ bot, hasApplicationConfig: () => false, repository })(now);

    // Then: only the pointer-free row is deleted locally.
    expect(result).toEqual({ hasMore: false, processedCount: 1, remainingLowerBound: 1 });
    expect(bot.deleteChannelMessage).not.toHaveBeenCalled();
    expect(repository.deleteExpiredCandidate).toHaveBeenCalledOnce();
    expect(repository.deleteExpiredCandidate).toHaveBeenCalledWith(localCandidate, now);
  });

  it("retains a row when its conditional ledger delete loses a race", async () => {
    // Given: Discord deletion succeeds but the row changes before local cleanup.
    const { bot, repository } = dependencies([botCandidate]);
    vi.mocked(repository.deleteExpiredCandidate).mockResolvedValue(false);

    // When: retention runs.
    const result = await createDiscordReservationRetention({ bot, hasApplicationConfig: () => true, repository })(now);

    // Then: the stale cleanup is rejected and reported as backlog.
    expect(result).toEqual({ hasMore: false, processedCount: 0, remainingLowerBound: 1 });
  });
});

function dependencies(candidates: readonly DiscordRetentionCandidate[], events: string[] = []) {
  const bot = {
    deleteChannelMessage: vi.fn<DiscordBotClient["deleteChannelMessage"]>(async ({ messageId }) => {
      events.push(`remote:${messageId}`);
      return { kind: "removed" };
    })
  } satisfies Pick<DiscordBotClient, "deleteChannelMessage">;
  const repository = {
    deleteExpiredCandidate: vi.fn<DiscordRetentionRepository["deleteExpiredCandidate"]>(async (candidate) => {
      events.push(`local:${candidate.reservationId}`);
      return true;
    }),
    findExpiredCandidates: vi.fn<DiscordRetentionRepository["findExpiredCandidates"]>(async () => candidates)
  } satisfies DiscordRetentionRepository;
  return { bot, repository };
}
