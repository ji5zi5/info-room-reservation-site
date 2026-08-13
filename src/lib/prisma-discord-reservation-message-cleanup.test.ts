import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  repositoryMocks,
  repositoryNow,
  resetRepositoryMocks
} from "./prisma-discord-reservation-message-test-support";
import {
  DISCORD_CLEANUP_BATCH_SIZE,
  prismaDiscordReservationMessageRepository
} from "./prisma-discord-reservation-message-repository";
import { deleteExpiredInteractionJobs } from "./prisma-discord-reservation-message-cleanup";

describe("Prisma Discord reservation message cleanup", () => {
  beforeEach(resetRepositoryMocks);

  it("deletes only bounded expired terminal interaction receipts", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      interactionId: `interaction-${index}`
    }));
    repositoryMocks.transaction.discordInteractionReceipt.findMany.mockResolvedValue(rows);
    repositoryMocks.transaction.discordInteractionReceipt.deleteMany.mockResolvedValue({ count: 100 });

    const result = await prismaDiscordReservationMessageRepository.deleteExpiredInteractionReceipts(
      repositoryNow
    );

    expect(DISCORD_CLEANUP_BATCH_SIZE).toBe(100);
    expect(result).toEqual({ hasMore: true, processedCount: 100, remainingLowerBound: 1 });
    expect(repositoryMocks.transaction.discordInteractionReceipt.deleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lte: repositoryNow },
        interactionId: { in: rows.slice(0, 100).map((row) => row.interactionId) },
        status: "TERMINAL"
      }
    });
  });

  it("deletes expired terminal message rows locally only when no bot message pointer exists", async () => {
    const rows = [{ reservationId: "webhook-only" }];
    repositoryMocks.transaction.discordReservationMessage.findMany.mockResolvedValue(rows);
    repositoryMocks.transaction.discordReservationMessage.deleteMany.mockResolvedValue({ count: 1 });

    const result = await prismaDiscordReservationMessageRepository.deleteExpiredMessages(repositoryNow);

    expect(result.processedCount).toBe(1);
    expect(repositoryMocks.transaction.discordReservationMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ messageId: null }) })
    );
    expect(repositoryMocks.transaction.discordReservationMessage.deleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lte: repositoryNow },
        initialSendStatus: { in: ["SENT", "ABANDONED"] },
        messageId: null,
        reservationId: { in: ["webhook-only"] },
        syncStatus: { in: ["SYNCED", "ABANDONED"] }
      }
    });
  });

  it("deletes only terminal Discord interaction jobs after their 30-day expiry", async () => {
    // Given: one expired terminal job selected by the retention query.
    const rows = [{ interactionId: "terminal-job" }];
    const transaction = {
      discordInteractionJob: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue(rows)
      }
    };

    // When: interaction-job retention runs.
    const result = await deleteExpiredInteractionJobs(repositoryNow, transaction);

    // Then: only expired succeeded, stale, or abandoned jobs are eligible.
    expect(result).toEqual({ hasMore: false, processedCount: 1, remainingLowerBound: 0 });
    expect(transaction.discordInteractionJob.deleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lte: repositoryNow },
        interactionId: { in: ["terminal-job"] },
        status: { in: ["SUCCEEDED", "STALE", "ABANDONED"] }
      }
    });
  });
});
