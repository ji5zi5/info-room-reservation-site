import { prisma } from "./db";
import { assertProductionEnvSafe } from "./env";
import { getPrismaNotificationSettings } from "./prisma-notification-settings";
import { getPrismaOperationalJobs } from "./prisma-operational-job-store";
import { getReadinessReport, type ReadinessReport } from "./readiness";

export async function getPrismaReadinessReport(now: Date = new Date()): Promise<ReadinessReport> {
  return getReadinessReport({
    assertConfig: () => assertProductionEnvSafe(),
    loadSnapshot: async () => {
      await prisma.$queryRaw`SELECT 1`;
      const [notificationSettings, jobs] = await Promise.all([
        getPrismaNotificationSettings(),
        getPrismaOperationalJobs()
      ]);
      return {
        closedPeriodNotificationsEnabled: notificationSettings.closedPeriodNotificationsEnabled,
        jobs
      };
    },
    now
  });
}
