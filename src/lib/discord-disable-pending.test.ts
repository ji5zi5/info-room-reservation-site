import { describe, expect, it, vi } from "vitest";

import {
  createDisableDiscordPending,
  createFencedDiscordDisable,
  reenableDiscordOperations,
  type DiscordDisablePendingRepository,
  type DiscordOperationsFenceRepository
} from "./discord-disable-pending";
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
  it("fences a new epoch before waiting for old reservation mutations and remote cleanup", async () => {
    // Given: one old mutation drains after the atomic fence and one pre-fence transport remains trackable.
    const events: string[] = [];
    const base = dependencies(events);
    const operations = operationsRepository(events, [1, 0], 1);

    // When: the fenced disable operation runs.
    const result = await createFencedDiscordDisable({
      ...base,
      loadSnapshot: async () => readySnapshot(),
      operations,
      wait: async () => { events.push("wait"); }
    })({ now });

    // Then: no cleanup claim begins until the old mutation drained and residual remote state stays explicit.
    expect(events).toEqual(["fence", "count", "wait", "count", "edit", "complete", "pending:true"]);
    expect(result).toMatchObject({ drainedMutations: 1, epoch: 8, pendingRemoteCleanup: true });
  });

  it("fails closed when old reservation mutations do not drain by the hard deadline", async () => {
    // Given: an old reservation mutation remains active through every bounded check.
    const events: string[] = [];
    const base = dependencies(events);
    const operations = operationsRepository(events, [1, 1], 0);

    // When/Then: disable refuses to begin remote cleanup after the deadline.
    await expect(createFencedDiscordDisable({
      ...base,
      loadSnapshot: async () => readySnapshot(),
      maxDrainChecks: 2,
      operations,
      wait: async () => { events.push("wait"); }
    })({ now })).rejects.toMatchObject({ code: "MUTATION_DRAIN_TIMEOUT" });
    expect(base.bot.editChannelMessage).not.toHaveBeenCalled();
    expect(events).toEqual(["fence", "count", "wait", "count", "pending:true"]);
    await expect(reenableDiscordOperations({ acknowledgeResidualInertControls: false, now, repository: operations }))
      .rejects.toMatchObject({ code: "RESIDUAL_ACK_REQUIRED" });
  });

  it("requires explicit residual inert-control acknowledgement before re-enable and advances epoch again", async () => {
    // Given: disable left pending remote cleanup at epoch eight.
    const events: string[] = [];
    const operations = operationsRepository(events, [], 0, true);

    // When/Then: missing acknowledgement is rejected, while explicit acknowledgement enables epoch nine.
    await expect(reenableDiscordOperations({ acknowledgeResidualInertControls: false, now, repository: operations }))
      .rejects.toMatchObject({ code: "RESIDUAL_ACK_REQUIRED" });
    await expect(reenableDiscordOperations({ acknowledgeResidualInertControls: true, now, repository: operations }))
      .resolves.toEqual({ enabled: true, epoch: 9, pendingRemoteCleanup: false });
  });

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

function operationsRepository(
  events: string[],
  activeMutationCounts: readonly number[],
  preFenceTransportCount: number,
  initialPendingRemoteCleanup = false
): DiscordOperationsFenceRepository {
  const counts = [...activeMutationCounts];
  let pendingRemoteCleanup = initialPendingRemoteCleanup;
  return {
    beginDisable: async () => {
      events.push("fence");
      return { epoch: 8, preFenceTransportCount };
    },
    countOldReservationMutations: async () => {
      events.push("count");
      return counts.shift() ?? 0;
    },
    reenable: async ({ acknowledgeResidualInertControls }) => {
      if (pendingRemoteCleanup && !acknowledgeResidualInertControls) return { kind: "ack_required" };
      pendingRemoteCleanup = false;
      return { control: { enabled: true, epoch: 9, pendingRemoteCleanup: false }, kind: "enabled" };
    },
    setPendingRemoteCleanup: async (pending) => {
      pendingRemoteCleanup = pending;
      events.push(`pending:${pending}`);
    }
  };
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
