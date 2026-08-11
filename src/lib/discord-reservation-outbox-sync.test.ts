import { beforeEach, describe, expect, it } from "vitest";

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
    dependencies.repository.claimMessageSync.mockResolvedValue(syncClaim());
    dependencies.repository.readMessageSyncState.mockResolvedValue({ cancellationReason: null, decision: "ACCEPTED" });

    const result = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(result.initial).toMatchObject({ claimed: 1, sent: 1 });
    expect(result.sync).toMatchObject({ claimed: 1, synced: 1 });
    expect(dependencies.bot.createChannelMessage).toHaveBeenCalledTimes(1);
    expect(dependencies.bot.editChannelMessage).toHaveBeenCalledTimes(1);
  });

  it("runs an interaction-style terminal source sync immediately by reservation id", async () => {
    dependencies.repository.claimInitialSend.mockResolvedValue(null);
    dependencies.repository.claimMessageSync.mockResolvedValue(syncClaim());
    dependencies.repository.readMessageSyncState.mockResolvedValue({
      cancellationReason: "상호작용 거절",
      decision: "CANCELLED"
    });
    dependencies.loadSnapshot.mockResolvedValue(snapshot("CANCELLED"));

    const result = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(result.sync).toMatchObject({ claimed: 1, synced: 1 });
    expect(dependencies.repository.claimMessageSync).toHaveBeenCalledWith(now, claim.reservationId);
    expect(dependencies.bot.editChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ components: [] })
    }));
  });

  it("syncs a newer cancelled source state without controls and uses the existing admin reason", async () => {
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
});
