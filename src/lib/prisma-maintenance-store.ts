import { prisma } from "./db";
import { systemDatabaseActor, userMutationLockKey, withDatabaseContext, withDatabaseMutation } from "./db-context";
import type { MaintenanceCleanupStore, MaintenanceExpiryBatchResult } from "./maintenance-service";
import { prismaRetentionStore } from "./prisma-retention-store";

export const prismaMaintenanceCleanupStore: MaintenanceCleanupStore = {
  async applyRetentionPolicy(now) {
    return prismaRetentionStore.applyScheduled({ now });
  },

  async deleteExpiredCsrfTokens(now) {
    const candidates = await withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
      operation: (transaction) => transaction.csrfToken.findMany({
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
        select: { id: true },
        take: 101,
        where: { expiresAt: { lte: now } }
      })
    });
    const ids = candidates.slice(0, 100).map((candidate) => candidate.id);
    if (ids.length === 0) {
      return expiryBatchResult(candidates.length, 0);
    }
    const result = await withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
      operation: (transaction) =>
        transaction.csrfToken.deleteMany({
          where: { expiresAt: { lte: now }, id: { in: ids } }
        })
    });
    return expiryBatchResult(candidates.length, result.count);
  },

  async deleteExpiredRateLimitBuckets(now) {
    const candidates = await withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
      operation: (transaction) => transaction.rateLimitBucket.findMany({
        orderBy: [{ expiresAt: "asc" }, { key: "asc" }],
        select: { key: true },
        take: 101,
        where: { expiresAt: { lte: now } }
      })
    });
    const keys = candidates.slice(0, 100).map((candidate) => candidate.key);
    if (keys.length === 0) {
      return expiryBatchResult(candidates.length, 0);
    }
    const result = await withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
      operation: (transaction) =>
        transaction.rateLimitBucket.deleteMany({
          where: { expiresAt: { lte: now }, key: { in: keys } }
        })
    });
    return expiryBatchResult(candidates.length, result.count);
  },

  async deleteExpiredSessions(now) {
    const candidates = await withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
      operation: (transaction) => transaction.session.findMany({
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
        select: { id: true },
        take: 101,
        where: { expiresAt: { lte: now } }
      })
    });
    const ids = candidates.slice(0, 100).map((candidate) => candidate.id);
    if (ids.length === 0) {
      return expiryBatchResult(candidates.length, 0);
    }
    const result = await withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
      operation: (transaction) =>
        transaction.session.deleteMany({
          where: { expiresAt: { lte: now }, id: { in: ids } }
        })
    });
    return expiryBatchResult(candidates.length, result.count);
  },

  async releaseExpiredRestrictions(now) {
    const candidates = await withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
      operation: (transaction) => transaction.user.findMany({
        orderBy: [{ restrictedUntil: "asc" }, { id: "asc" }],
        select: { id: true },
        take: 101,
        where: {
          bookingStatus: "RESTRICTED",
          restrictedUntil: { lte: now }
        }
      })
    });
    const selected = candidates.slice(0, 100);
    if (selected.length === 0) {
      return expiryBatchResult(candidates.length, 0);
    }
    const result = await withDatabaseMutation({
      actor: systemDatabaseActor(),
      client: prisma,
      lockKeys: selected.map((candidate) => userMutationLockKey(candidate.id)),
      operation: (transaction) =>
        transaction.user.updateMany({
          data: {
            bookingStatus: "ACTIVE",
            restrictedUntil: null,
            restrictionReason: null
          },
          where: {
            bookingStatus: "RESTRICTED",
            id: { in: selected.map((candidate) => candidate.id) },
            restrictedUntil: { lte: now }
          }
        })
    });
    return expiryBatchResult(candidates.length, result.count);
  },

  async revokeExpiredSanctions(now) {
    const candidates = await withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
      operation: (transaction) => transaction.userSanction.findMany({
        orderBy: [{ endsAt: "asc" }, { id: "asc" }],
        select: { id: true, userId: true },
        take: 101,
        where: {
          endsAt: { lte: now },
          status: "ACTIVE"
        }
      })
    });
    const selected = candidates.slice(0, 100);
    if (selected.length === 0) {
      return expiryBatchResult(candidates.length, 0);
    }
    const result = await withDatabaseMutation({
      actor: systemDatabaseActor(),
      client: prisma,
      lockKeys: selected.map((candidate) => userMutationLockKey(candidate.userId)),
      operation: (transaction) =>
        transaction.userSanction.updateMany({
          data: {
            revokedAt: now,
            revokedById: null,
            revokedReason: "기간 만료",
            status: "REVOKED"
          },
          where: {
            endsAt: { lte: now },
            id: { in: selected.map((candidate) => candidate.id) },
            status: "ACTIVE"
          }
        })
    });
    return expiryBatchResult(candidates.length, result.count);
  }
};

function expiryBatchResult(candidateCount: number, processedCount: number): MaintenanceExpiryBatchResult {
  const hasMore = candidateCount > 100;
  return {
    hasMore,
    processedCount,
    remainingLowerBound: hasMore ? 1 : 0
  };
}
