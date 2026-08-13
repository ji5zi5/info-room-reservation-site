import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDiscordReservationOutbox } from "./discord-reservation-outbox";
import {
  claim,
  dependenciesFixture,
  now,
  snapshot,
  syncClaim
} from "./discord-reservation-outbox-test-fixtures";

describe("Discord reservation outbox orchestration and sync", () => {
  let dependencies: ReturnType<typeof dependenciesFixture>;

  beforeEach(() => {
    dependencies = dependenciesFixture();
  });

  it("prioritizes a single immediate reservation claim", async () => {
    await createDiscordReservationOutbox(dependencies)({ now, reservationId: "reservation-priority" });

    expect(dependencies.repository.claimInitialSend).toHaveBeenCalledWith(now, "reservation-priority");
    expect(dependencies.repository.claimMessageSync).toHaveBeenCalledWith(now, "reservation-priority");
    expect(dependencies.repository.claimInitialSends).not.toHaveBeenCalled();
    expect(dependencies.repository.claimMessageSyncs).not.toHaveBeenCalled();
  });

  it("handles eligible initial and source-sync claims in one reservation-scoped run", async () => {
    const leases = syncLeaseRepository();
    Object.assign(dependencies.repository, leases);
    dependencies.repository.claimMessageSync.mockResolvedValue(syncClaim());
    dependencies.repository.readMessageSyncState.mockResolvedValue({ cancellationReason: null, decision: "ACCEPTED" });

    const result = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(result.initial).toMatchObject({ claimed: 1, sent: 1 });
    expect(result.sync).toMatchObject({ claimed: 1, synced: 1 });
    expect(dependencies.bot.createChannelMessage).toHaveBeenCalledTimes(1);
    expect(dependencies.bot.editChannelMessage).toHaveBeenCalledTimes(1);
  });

  it("runs an interaction-style terminal source sync immediately by reservation id", async () => {
    Object.assign(dependencies.repository, syncLeaseRepository());
    dependencies.repository.claimInitialSend.mockResolvedValue(null);
    dependencies.repository.claimMessageSync.mockResolvedValue(syncClaim());
    dependencies.repository.readMessageSyncState.mockResolvedValue({
      cancellationReason: "상호작용 거절",
      decision: "CANCELLED",
      decisionDiscordActorId: "223456789012345678",
      decidedAt: now,
      operationIntent: "REJECT"
    });
    dependencies.loadSnapshot.mockResolvedValue(snapshot("CANCELLED"));

    const result = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(result.sync).toMatchObject({ claimed: 1, synced: 1 });
    expect(dependencies.repository.claimMessageSync).toHaveBeenCalledWith(now, claim.reservationId);
    expect(dependencies.bot.editChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ components: [] })
    }));
    const payload = dependencies.bot.editChannelMessage.mock.calls[0]?.[0]?.payload;
    expect(payload?.embeds[0]?.fields).toEqual(expect.arrayContaining([
      { inline: false, name: "처리 작업", value: "예약 거절" },
      { inline: false, name: "처리 관리자", value: "223456789012345678" },
      { inline: false, name: "처리 시각", value: now.toISOString() },
      { inline: false, name: "처리 사유", value: "상호작용 거절" }
    ]));
  });

  it("syncs a newer cancelled source state without controls and uses the existing admin reason", async () => {
    Object.assign(dependencies.repository, syncLeaseRepository());
    dependencies.repository.claimInitialSend.mockResolvedValue(null);
    dependencies.repository.claimMessageSyncs.mockResolvedValue([{
      attempts: 1,
      channelId: "channel",
      claimId: "sync-claim",
      guildId: "guild",
      messageId: "message",
      reservationId: claim.reservationId,
      revision: 2
    }]);
    dependencies.repository.readMessageSyncState.mockResolvedValue({
      cancellationReason: "관리자 취소 사유",
      decision: "ACCEPTED"
    });
    dependencies.loadSnapshot.mockResolvedValue(snapshot("CANCELLED"));
    dependencies.bot.editChannelMessage.mockResolvedValue({ kind: "sent", messageId: "message" });

    const result = await createDiscordReservationOutbox(dependencies)({ now });

    expect(result.sync).toMatchObject({ claimed: 1, synced: 1 });
    expect(dependencies.bot.editChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ components: [] })
    }));
    expect(JSON.stringify(dependencies.bot.editChannelMessage.mock.calls[0]?.[0])).toContain("관리자 취소 사유");
  });

  it("registers PATCHING before transport and settles a definitive response with the leased epoch", async () => {
    // Given: an enabled epoch and an accepted reservation revision.
    dependencies.repository.claimInitialSend.mockResolvedValue(null);
    dependencies.repository.claimMessageSync.mockResolvedValue(syncClaim());
    dependencies.repository.readMessageSyncState.mockResolvedValue({ cancellationReason: null, decision: "ACCEPTED" });
    const leases = syncLeaseRepository();
    Object.assign(dependencies.repository, leases);

    // When: the source message is synchronized.
    const result = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    // Then: PATCHING is durable before the PATCH, and success persists the rendered epoch.
    expect(result.sync).toMatchObject({ synced: 1 });
    expect(leases.beginSyncPatch.mock.invocationCallOrder[0]).toBeLessThan(dependencies.bot.editChannelMessage.mock.invocationCallOrder[0] ?? 0);
    expect(leases.saveLeasedSyncSuccess).toHaveBeenCalledWith(expect.objectContaining({ epoch: 7, operationId: "sync-claim" }));
    expect(dependencies.bot.editChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ components: [expect.objectContaining({ components: expect.arrayContaining([
        expect.objectContaining({ label: "관리자 취소" }),
        expect.objectContaining({ label: "노쇼" })
      ]) })] })
    }));
  });

  it("keeps an ambiguous PATCH in review instead of retrying or settling it", async () => {
    // Given: transport loses the PATCH response after the durable lease.
    dependencies.repository.claimInitialSend.mockResolvedValue(null);
    dependencies.repository.claimMessageSync.mockResolvedValue(syncClaim());
    const leases = syncLeaseRepository();
    Object.assign(dependencies.repository, leases);
    dependencies.bot.editChannelMessage.mockResolvedValue({ code: "discord_timeout", kind: "unknown", message: "timeout", outcome: "UNKNOWN" });

    // When: synchronization cannot determine Discord's remote state.
    await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    // Then: it becomes review work and is never scheduled as an ordinary retry.
    expect(leases.markSyncPendingReview).toHaveBeenCalledWith(expect.objectContaining({ reason: "discord_timeout" }));
    expect(dependencies.repository.saveSyncFailure).not.toHaveBeenCalled();
    expect(dependencies.repository.saveSyncSuccess).not.toHaveBeenCalled();
  });

  it("rerenders a known legacy pending source with signed current-epoch controls", async () => {
    dependencies.repository.claimInitialSend.mockResolvedValue(null);
    dependencies.repository.claimMessageSync.mockResolvedValue(syncClaim());
    dependencies.repository.readMessageSyncState.mockResolvedValue({
      cancellationReason: null,
      decision: null,
      nonce: "reservation-source-1",
      renderedSourceEpoch: 0
    });
    Object.assign(dependencies.repository, syncLeaseRepository());

    await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    const serialized = JSON.stringify(dependencies.bot.editChannelMessage.mock.calls[0]?.[0]?.payload);
    expect(serialized).toContain("dr2.a.7.");
    expect(serialized).toContain("dr2.r.7.");
    expect(serialized).not.toContain("reservation:accept:");
  });
});

function syncLeaseRepository() {
  return {
    beginSyncPatch: vi.fn(async () => true),
    markSyncPendingReview: vi.fn(async () => true),
    readOperationsControl: vi.fn(async () => ({ enabled: true, epoch: 7, pendingRemoteCleanup: false }))
    ,saveLeasedSyncSuccess: vi.fn(async () => true)
  };
}
