import type { RetentionCleanupResult } from "./retention-policy";
import { prismaDiscordReservationMessageRepository } from "./prisma-discord-reservation-message-repository";

export type MaintenanceCleanupResult = {
  readonly backlogCount: number;
  readonly csrfTokensDeleted: number;
  readonly discordInteractionReceiptsDeleted: number;
  readonly discordMessagesDeleted: number;
  readonly expiredSanctionsRevoked: number;
  readonly rateLimitBucketsDeleted: number;
  readonly retention: RetentionCleanupResult;
  readonly restrictionsReleased: number;
  readonly sessionsDeleted: number;
};

export type MaintenanceExpiryBatchResult = {
  readonly hasMore: boolean;
  readonly processedCount: number;
  readonly remainingLowerBound: number;
};

export type MaintenanceCleanupStore = {
  readonly applyRetentionPolicy: (now: Date) => Promise<RetentionCleanupResult>;
  readonly deleteExpiredCsrfTokens: (now: Date) => Promise<MaintenanceExpiryBatchResult>;
  readonly deleteExpiredRateLimitBuckets: (now: Date) => Promise<MaintenanceExpiryBatchResult>;
  readonly deleteExpiredSessions: (now: Date) => Promise<MaintenanceExpiryBatchResult>;
  readonly releaseExpiredRestrictions: (now: Date) => Promise<MaintenanceExpiryBatchResult>;
  readonly revokeExpiredSanctions: (now: Date) => Promise<MaintenanceExpiryBatchResult>;
};

export type DiscordMaintenanceCleanupStore = {
  readonly deleteExpiredInteractionReceipts: (now: Date) => Promise<MaintenanceExpiryBatchResult>;
  readonly deleteExpiredMessages: (now: Date) => Promise<MaintenanceExpiryBatchResult>;
};

const MAX_EXPIRY_BATCHES = 10;

export async function runMaintenanceCleanup(input: {
  readonly discordStore?: DiscordMaintenanceCleanupStore;
  readonly now: Date;
  readonly store: MaintenanceCleanupStore;
}): Promise<MaintenanceCleanupResult> {
  const discordStore = input.discordStore ?? prismaDiscordReservationMessageRepository;
  const discordMessages = await drainExpiryBatches(() => discordStore.deleteExpiredMessages(input.now));
  const discordReceipts = await drainExpiryBatches(() => discordStore.deleteExpiredInteractionReceipts(input.now));
  const sessions = await drainExpiryBatches(() => input.store.deleteExpiredSessions(input.now));
  const csrfTokens = await drainExpiryBatches(() => input.store.deleteExpiredCsrfTokens(input.now));
  const rateLimitBuckets = await drainExpiryBatches(() => input.store.deleteExpiredRateLimitBuckets(input.now));
  const restrictions = await drainExpiryBatches(() => input.store.releaseExpiredRestrictions(input.now));
  const expiredSanctions = await drainExpiryBatches(() => input.store.revokeExpiredSanctions(input.now));
  const retention = await input.store.applyRetentionPolicy(input.now);

  return {
    backlogCount:
      sessions.remainingLowerBound +
      discordMessages.remainingLowerBound +
      discordReceipts.remainingLowerBound +
      csrfTokens.remainingLowerBound +
      rateLimitBuckets.remainingLowerBound +
      restrictions.remainingLowerBound +
      expiredSanctions.remainingLowerBound,
    csrfTokensDeleted: csrfTokens.processedCount,
    discordInteractionReceiptsDeleted: discordReceipts.processedCount,
    discordMessagesDeleted: discordMessages.processedCount,
    expiredSanctionsRevoked: expiredSanctions.processedCount,
    rateLimitBucketsDeleted: rateLimitBuckets.processedCount,
    retention,
    restrictionsReleased: restrictions.processedCount,
    sessionsDeleted: sessions.processedCount
  };
}

async function drainExpiryBatches(
  expireBatch: () => Promise<MaintenanceExpiryBatchResult>
): Promise<{ readonly processedCount: number; readonly remainingLowerBound: number }> {
  let processedCount = 0;
  for (let batchNumber = 0; batchNumber < MAX_EXPIRY_BATCHES; batchNumber += 1) {
    const batch = await expireBatch();
    processedCount += batch.processedCount;
    if (!batch.hasMore) {
      return { processedCount, remainingLowerBound: 0 };
    }
    if (batchNumber === MAX_EXPIRY_BATCHES - 1) {
      return { processedCount, remainingLowerBound: batch.remainingLowerBound };
    }
  }
  return { processedCount, remainingLowerBound: 0 };
}
