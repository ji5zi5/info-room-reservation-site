import { Prisma } from "@prisma/client";

import type { MaintenanceExpiryBatchResult } from "./maintenance-service";
import { withDiscordReservationMessageSystemContext } from "./prisma-discord-reservation-message-context";

export const DISCORD_CLEANUP_BATCH_SIZE = 100;

export function deleteExpiredInteractionReceipts(now: Date): Promise<MaintenanceExpiryBatchResult> {
  return withDiscordReservationMessageSystemContext(async (transaction) => {
    const candidates = await transaction.discordInteractionReceipt.findMany({
      orderBy: [{ expiresAt: "asc" }, { interactionId: "asc" }],
      select: { interactionId: true },
      take: DISCORD_CLEANUP_BATCH_SIZE + 1,
      where: { expiresAt: { lte: now }, status: "TERMINAL" }
    });
    const ids = candidates.slice(0, DISCORD_CLEANUP_BATCH_SIZE).map((row) => row.interactionId);
    const processedCount = ids.length === 0 ? 0 : (
      await transaction.discordInteractionReceipt.deleteMany({
        where: { interactionId: { in: ids }, expiresAt: { lte: now }, status: "TERMINAL" }
      })
    ).count;
    return cleanupResult(candidates.length, processedCount);
  });
}

export function deleteExpiredMessages(now: Date): Promise<MaintenanceExpiryBatchResult> {
  return withDiscordReservationMessageSystemContext(async (transaction) => {
    const terminalWithoutPointer = {
      expiresAt: { lte: now },
      initialSendStatus: { in: ["SENT", "ABANDONED"] },
      messageId: null,
      syncStatus: { in: ["SYNCED", "ABANDONED"] }
    } satisfies Prisma.DiscordReservationMessageWhereInput;
    const candidates = await transaction.discordReservationMessage.findMany({
      orderBy: [{ expiresAt: "asc" }, { reservationId: "asc" }],
      select: { reservationId: true },
      take: DISCORD_CLEANUP_BATCH_SIZE + 1,
      where: terminalWithoutPointer
    });
    const ids = candidates.slice(0, DISCORD_CLEANUP_BATCH_SIZE).map((row) => row.reservationId);
    const processedCount = ids.length === 0 ? 0 : (
      await transaction.discordReservationMessage.deleteMany({
        where: { ...terminalWithoutPointer, reservationId: { in: ids } }
      })
    ).count;
    return cleanupResult(candidates.length, processedCount);
  });
}

function cleanupResult(candidateCount: number, processedCount: number): MaintenanceExpiryBatchResult {
  return {
    hasMore: candidateCount > DISCORD_CLEANUP_BATCH_SIZE,
    processedCount,
    remainingLowerBound: candidateCount > DISCORD_CLEANUP_BATCH_SIZE ? 1 : 0
  };
}
