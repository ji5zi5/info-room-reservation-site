import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";
import type { MaintenanceCleanupStore } from "./maintenance-service";

export const prismaMaintenanceCleanupStore: MaintenanceCleanupStore = {
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
    const result = await withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
      operation: (transaction) =>
        transaction.user.updateMany({
          data: {
            bookingStatus: "ACTIVE",
            restrictedUntil: null,
            restrictionReason: null
          },
          where: {
            bookingStatus: "RESTRICTED",
            restrictedUntil: { lte: now }
          }
        })
    });
    return result.count;
  },

  async revokeExpiredSanctions(now) {
    const result = await withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
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
            status: "ACTIVE"
          }
        })
    });
    return result.count;
  }
};
