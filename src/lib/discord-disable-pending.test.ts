import { describe, expect, it, vi } from "vitest";

import { createDisableDiscordPending, type DiscordDisablePendingRepository } from "./discord-disable-pending";
import type { DiscordBotClient } from "./discord-bot";
import type { DiscordReservationSnapshotResult } from "./discord-reservation-snapshot";

const now = new Date("2026-08-11T00:00:00.000Z");
const claim = {
  channelId: "channel",
  claimId: "claim",
  messageId: "message",
  reservationId: "reservation",
  revision: 2
};

describe("emergency Discord interaction rollback", () => {
  it("edits each claimed active message to stale controls-free content before marking it disabled", async () => {
    // Given: one active bot message with a current reservation snapshot.
    const events: string[] = [];
    const { bot, repository } = dependencies(events);

    // When: the emergency rollback runs.
    const result = await createDisableDiscordPending({ bot, loadSnapshot: async () => readySnapshot(), repository })({ now });

    // Then: Discord is edited before the atomic disabled marker is stored.
    expect(result).toEqual({ claimed: 1, disabled: 1, failed: 0, hasMore: false });
    expect(events).toEqual(["edit", "complete"]);
    expect(bot.editChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "channel",
      messageId: "message",
      payload: expect.objectContaining({ allowed_mentions: { parse: [] }, components: [] })
    }));
    expect(repository.completeDisableClaim).toHaveBeenCalledWith(claim, now);
  });

  it("releases the claim and reports backlog when Discord edit fails", async () => {
    // Given: Discord rejects the controls-free edit.
    const { bot, repository } = dependencies();
    vi.mocked(repository.claimActiveMessagesForDisable).mockResolvedValue([claim]);
    vi.mocked(bot.editChannelMessage).mockResolvedValue({
      code: "discord_http_403",
      kind: "failed",
      message: "forbidden",
      outcome: "FAILED"
    });

    // When: rollback runs.
    const result = await createDisableDiscordPending({ bot, loadSnapshot: async () => readySnapshot(), repository })({ now });

    // Then: no disabled marker is written and the claim is recoverable.
    expect(result).toEqual({ claimed: 1, disabled: 0, failed: 1, hasMore: true });
    expect(repository.completeDisableClaim).not.toHaveBeenCalled();
    expect(repository.releaseDisableClaim).toHaveBeenCalledWith(claim);
    expect(repository.claimActiveMessagesForDisable).toHaveBeenCalledOnce();
  });

  it("does not edit or complete a claim when the reservation snapshot is gone", async () => {
    // Given: the claimed ledger row has no reservation snapshot.
    const { bot, repository } = dependencies();

    // When: rollback runs.
    const result = await createDisableDiscordPending({
      bot,
      loadSnapshot: async () => ({ kind: "not_found", reservationId: claim.reservationId }),
      repository
    })({ now });

    // Then: the row remains backlogged without an untruthful replacement payload.
    expect(result.failed).toBe(1);
    expect(bot.editChannelMessage).not.toHaveBeenCalled();
    expect(repository.releaseDisableClaim).toHaveBeenCalledWith(claim);
  });
});

function dependencies(events: string[] = []) {
  const bot = {
    editChannelMessage: vi.fn<DiscordBotClient["editChannelMessage"]>(async () => {
      events.push("edit");
      return { kind: "sent", messageId: "message" };
    })
  } satisfies Pick<DiscordBotClient, "editChannelMessage">;
  const repository = {
    claimActiveMessagesForDisable: vi.fn<DiscordDisablePendingRepository["claimActiveMessagesForDisable"]>()
      .mockResolvedValueOnce([claim])
      .mockResolvedValueOnce([]),
    completeDisableClaim: vi.fn<DiscordDisablePendingRepository["completeDisableClaim"]>(async () => {
      events.push("complete");
      return true;
    }),
    releaseDisableClaim: vi.fn<DiscordDisablePendingRepository["releaseDisableClaim"]>(async () => true)
  } satisfies DiscordDisablePendingRepository;
  return { bot, repository };
}

function readySnapshot(): DiscordReservationSnapshotResult {
  return {
    kind: "ready",
    snapshot: {
      capacity: 10,
      closeAtUnix: 1_786_419_000,
      confirmedCount: 4,
      effectiveSetting: {
        capacity: 10,
        closeTime: "16:30",
        date: "2026-08-11",
        enabled: true,
        openTime: "08:00",
        studyPeriod: "EIGHTH"
      },
      remaining: 6,
      reservation: {
        date: "2026-08-11",
        id: "reservation",
        reason: "학습",
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        user: { id: "user", name: "학생", studentNumber: "12345" },
        userId: "user"
      }
    }
  };
}
