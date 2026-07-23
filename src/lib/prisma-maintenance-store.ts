import { prisma } from "./db";
import { systemDatabaseActor, userMutationLockKey, withDatabaseContext, withDatabaseMutation } from "./db-context";
import type { MaintenanceCleanupStore } from "./maintenance-service";
import { prismaRetentionStore } from "./prisma-retention-store";

export const prismaMaintenanceCleanupStore: MaintenanceCleanupStore = {
  async applyRetentionPolicy(now) {
    return prismaRetentionStore.applyScheduled({ now });
  },

  async deleteExpiredCsrfTokens(now) {
    const result = await withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
      operation: (transaction) =>
        transaction.csrfToken.deleteMany({
          where: { expiresAt: { lte: now } }
        })
    });
    return result.count;
  },

  async deleteExpiredRateLimitBuckets(now) {
    const result = await withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
      operation: (transaction) =>
        transaction.rateLimitBucket.deleteMany({
          where: { expiresAt: { lte: now } }
        })
    });
    return result.count;
  },

  async deleteExpiredSessions(now) {
    const result = await withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
      operation: (transaction) =>
        transaction.session.deleteMany({
          where: { expiresAt: { lte: now } }
        })
    });
    return result.count;
  },

  async releaseExpiredRestrictions(now) {
    const candidates = await prisma.user.findMany({
      orderBy: { id: "asc" },
      select: { id: true },
      take: 100,
      where: {
        bookingStatus: "RESTRICTED",
        restrictedUntil: { lte: now }
      }
    });
    if (candidates.length === 0) {
      return 0;
    }
    const result = await withDatabaseMutation({
      actor: systemDatabaseActor(),
      client: prisma,
      lockKeys: candidates.map((candidate) => userMutationLockKey(candidate.id)),
      operation: (transaction) =>
        transaction.user.updateMany({
          data: {
            bookingStatus: "ACTIVE",
            restrictedUntil: null,
            restrictionReason: null
          },
          where: {
            bookingStatus: "RESTRICTED",
            id: { in: candidates.map((candidate) => candidate.id) },
            restrictedUntil: { lte: now }
          }
        })
    });
    return result.count;
  },

  async revokeExpiredSanctions(now) {
    const candidates = await prisma.userSanction.findMany({
      orderBy: { id: "asc" },
      select: { userId: true },
      take: 100,
      where: {
        endsAt: { lte: now },
        status: "ACTIVE"
      }
    });
    if (candidates.length === 0) {
      return 0;
    }
    const result = await withDatabaseMutation({
      actor: systemDatabaseActor(),
      client: prisma,
      lockKeys: candidates.map((candidate) => userMutationLockKey(candidate.userId)),
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
            status: "ACTIVE",
            userId: { in: candidates.map((candidate) => candidate.userId) }
          }
        })
    });
    return result.count;
  }
};
