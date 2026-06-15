import { prisma } from "./db";
import type { MaintenanceCleanupStore } from "./maintenance-service";

export const prismaMaintenanceCleanupStore: MaintenanceCleanupStore = {
  async deleteExpiredCsrfTokens(now) {
    const result = await prisma.csrfToken.deleteMany({
      where: { expiresAt: { lte: now } }
    });
    return result.count;
  },

  async deleteExpiredRateLimitBuckets(now) {
    const result = await prisma.rateLimitBucket.deleteMany({
      where: { expiresAt: { lte: now } }
    });
    return result.count;
  },

  async deleteExpiredSessions(now) {
    const result = await prisma.session.deleteMany({
      where: { expiresAt: { lte: now } }
    });
    return result.count;
  },

  async releaseExpiredRestrictions(now) {
    const result = await prisma.user.updateMany({
      data: {
        bookingStatus: "ACTIVE",
        restrictedUntil: null,
        restrictionReason: null
      },
      where: {
        bookingStatus: "RESTRICTED",
        restrictedUntil: { lte: now }
      }
    });
    return result.count;
  },

  async revokeExpiredSanctions(now) {
    const result = await prisma.userSanction.updateMany({
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
    });
    return result.count;
  }
};
