import { Prisma } from "@prisma/client";

import type { MaintenanceExpiryBatchResult } from "./maintenance-service";
import { withDiscordReservationMessageSystemContext } from "./prisma-discord-reservation-message-context";

export const DISCORD_CLEANUP_BATCH_SIZE = 100;

type DiscordInteractionJobCleanupTransaction = {
  readonly discordAdminCommandJob?: {
    readonly deleteMany: (
      input: Prisma.DiscordAdminCommandJobDeleteManyArgs
    ) => PromiseLike<Prisma.BatchPayload>;
    readonly findMany: (
      input: Prisma.DiscordAdminCommandJobFindManyArgs
    ) => PromiseLike<readonly { readonly id: string }[]>;
  };
  readonly discordInteractionJob: {
    readonly deleteMany: (
      input: Prisma.DiscordInteractionJobDeleteManyArgs
    ) => PromiseLike<Prisma.BatchPayload>;
    readonly findMany: (
      input: Prisma.DiscordInteractionJobFindManyArgs
    ) => PromiseLike<readonly { readonly interactionId: string }[]>;
  };
};

export function deleteExpiredInteractionJobs(
  now: Date,
  transaction?: DiscordInteractionJobCleanupTransaction
): Promise<MaintenanceExpiryBatchResult> {
  if (transaction !== undefined) {
    return deleteExpiredInteractionJobsInTransaction(now, transaction);
  }
  return withDiscordReservationMessageSystemContext((current) =>
    deleteExpiredInteractionJobsInTransaction(now, current)
  );
}

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

async function deleteExpiredInteractionJobsInTransaction(
  now: Date,
  transaction: DiscordInteractionJobCleanupTransaction
): Promise<MaintenanceExpiryBatchResult> {
  const terminalExpired = {
    expiresAt: { lte: now },
    status: { in: ["SUCCEEDED", "STALE", "ABANDONED"] }
  } satisfies Prisma.DiscordInteractionJobWhereInput;
  const candidates = await transaction.discordInteractionJob.findMany({
    orderBy: [{ expiresAt: "asc" }, { interactionId: "asc" }],
    select: { interactionId: true },
    take: DISCORD_CLEANUP_BATCH_SIZE + 1,
    where: terminalExpired
  });
  const ids = candidates.slice(0, DISCORD_CLEANUP_BATCH_SIZE).map((row) => row.interactionId);
  const interactionProcessedCount = ids.length === 0 ? 0 : (
    await transaction.discordInteractionJob.deleteMany({
      where: { ...terminalExpired, interactionId: { in: ids } }
    })
  ).count;
  if (transaction.discordAdminCommandJob === undefined) {
    return cleanupResult(candidates.length, interactionProcessedCount);
  }
  const adminTerminalExpired = {
    expiresAt: { lte: now },
    OR: [
      { status: { in: ["SUCCEEDED", "STALE", "ABANDONED"] } },
      { handshakeStatus: { in: ["AWAITING_REASON", "STAGED"] } }
    ]
  } satisfies Prisma.DiscordAdminCommandJobWhereInput;
  const adminCandidates = await transaction.discordAdminCommandJob.findMany({
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    select: { id: true },
    take: DISCORD_CLEANUP_BATCH_SIZE + 1,
    where: adminTerminalExpired
  });
  const adminIds = adminCandidates.slice(0, DISCORD_CLEANUP_BATCH_SIZE).map((row) => row.id);
  const adminProcessedCount = adminIds.length === 0 ? 0 : (
    await transaction.discordAdminCommandJob.deleteMany({
      where: { ...adminTerminalExpired, id: { in: adminIds } }
    })
  ).count;
  return {
    hasMore: candidates.length > DISCORD_CLEANUP_BATCH_SIZE || adminCandidates.length > DISCORD_CLEANUP_BATCH_SIZE,
    processedCount: interactionProcessedCount + adminProcessedCount,
    remainingLowerBound: candidates.length > DISCORD_CLEANUP_BATCH_SIZE || adminCandidates.length > DISCORD_CLEANUP_BATCH_SIZE ? 1 : 0
  };
}
