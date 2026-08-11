import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => {
  const discordReservationMessage = {
    deleteMany: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn<(input: Prisma.DiscordReservationMessageUpdateManyArgs) => Promise<Prisma.BatchPayload>>()
  };
  const transaction = { discordReservationMessage };
  return {
    transaction,
    withDatabaseContext: vi.fn(async (input: { readonly operation: (value: typeof transaction) => Promise<unknown> }) =>
      input.operation(transaction)
    )
  };
});

vi.mock("./db", () => ({ prisma: { kind: "prisma" } }));
vi.mock("./db-context", () => ({
  systemDatabaseActor: () => ({ id: null, role: "SYSTEM" }),
  withDatabaseContext: repositoryMocks.withDatabaseContext
}));

import { prismaDiscordReservationMaintenanceRepository } from "./prisma-discord-reservation-maintenance-repository";

const now = new Date("2026-08-11T00:00:00.000Z");
const candidate = {
  channelId: "channel",
  expiresAt: new Date("2026-08-10T00:00:00.000Z"),
  messageId: "message",
  reservationId: "reservation",
  updatedAt: new Date("2026-08-10T01:00:00.000Z")
};

describe("Prisma Discord maintenance repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repositoryMocks.transaction.discordReservationMessage.findMany.mockResolvedValue([]);
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 0 });
    repositoryMocks.transaction.discordReservationMessage.deleteMany.mockResolvedValue({ count: 0 });
  });

  it("claims only unexpired undecided sent bot messages with a stale-lease recovery path", async () => {
    // Given: one eligible active bot message.
    repositoryMocks.transaction.discordReservationMessage.findMany.mockResolvedValue([{
      channelId: "channel",
      messageId: "message",
      messageRevision: 2,
      reservationId: "reservation"
    }]);
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });

    // When: rollback candidates are claimed.
    const claims = await prismaDiscordReservationMaintenanceRepository.claimActiveMessagesForDisable(now);

    // Then: active filters and the exact revision guard the claim.
    expect(claims).toHaveLength(1);
    expect(repositoryMocks.transaction.discordReservationMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 20,
      where: expect.objectContaining({
        decision: null,
        expiresAt: { gt: now },
        initialSendStatus: "SENT",
        messageId: { not: null },
        OR: expect.arrayContaining([{ syncClaimedAt: { lte: new Date("2026-08-10T23:58:00.000Z") }, syncStatus: "SYNCING" }])
      })
    }));
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ messageRevision: 2, reservationId: "reservation" })
    }));
  });

  it("marks controls disabled only while the rollback owns the unchanged message revision", async () => {
    // Given: the rollback still owns its claim.
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });
    const claim = { channelId: "channel", claimId: "claim", messageId: "message", reservationId: "reservation", revision: 2 };

    // When: the remote edit is completed.
    const completed = await prismaDiscordReservationMaintenanceRepository.completeDisableClaim(claim, now);

    // Then: the durable decision prevents interactions and future controls-bearing sync.
    expect(completed).toBe(true);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({ decision: "DISABLED", syncStatus: "SYNCED", syncedRevision: 2 }),
      where: expect.objectContaining({
        decision: null,
        messageRevision: 2,
        syncClaimId: "claim",
        syncStatus: "SYNCING"
      })
    });
  });

  it("enumerates only expired terminal rows and conditionally deletes the unchanged candidate", async () => {
    // Given: an expired terminal candidate remains unchanged.
    repositoryMocks.transaction.discordReservationMessage.findMany.mockResolvedValue([candidate]);
    repositoryMocks.transaction.discordReservationMessage.deleteMany.mockResolvedValue({ count: 1 });

    // When: it is enumerated and deleted.
    const candidates = await prismaDiscordReservationMaintenanceRepository.findExpiredCandidates(now);
    const deleted = await prismaDiscordReservationMaintenanceRepository.deleteExpiredCandidate(candidate, now);

    // Then: both reads and writes reject active, unexpired, or changed rows.
    expect(candidates).toEqual([candidate]);
    expect(deleted).toBe(true);
    expect(repositoryMocks.transaction.discordReservationMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 101,
      where: {
        expiresAt: { lte: now },
        initialSendStatus: { in: ["SENT", "ABANDONED"] },
        syncStatus: { in: ["SYNCED", "ABANDONED"] }
      }
    }));
    expect(repositoryMocks.transaction.discordReservationMessage.deleteMany).toHaveBeenCalledWith({
      where: {
        channelId: "channel",
        expiresAt: { lte: now },
        initialSendStatus: { in: ["SENT", "ABANDONED"] },
        messageId: "message",
        reservationId: "reservation",
        syncStatus: { in: ["SYNCED", "ABANDONED"] },
        updatedAt: candidate.updatedAt
      }
    });
  });
});
