import { prisma } from "./db";
import { parseDiscordApplicationConfig } from "./discord-app-config";
import { assertProductionEnvSafe } from "./env";
import { getPrismaNotificationSettings } from "./prisma-notification-settings";
import { getPrismaOperationalJobs } from "./prisma-operational-job-store";
import { getPrismaDiscordReadinessState } from "./prisma-discord-reservation-maintenance-repository";
import { getReadinessReport, type ReadinessReport } from "./readiness";

export async function getPrismaReadinessReport(now: Date = new Date()): Promise<ReadinessReport> {
  return getReadinessReport({
    assertConfig: () => assertProductionEnvSafe(),
    loadSnapshot: async () => {
      await prisma.$queryRaw`SELECT 1`;
      const [notificationSettings, jobs, discord] = await Promise.all([
        getPrismaNotificationSettings(),
        getPrismaOperationalJobs(),
        getPrismaDiscordReadinessState(now)
      ]);
      return {
        closedPeriodNotificationsEnabled: notificationSettings.closedPeriodNotificationsEnabled,
        discord: {
          interactions: {
            enabled: discord.interactionsEnabled,
            retentionBacklogCount: discord.interactionsRetentionBacklogCount
          },
          reservationOutbox: {
            enabled: discord.interactionsEnabled
              && notificationSettings.reservationCreatedNotificationsEnabled,
            retentionBacklogCount: discord.reservationOutboxRetentionBacklogCount
          }
        },
        discordOperationsEnabled: parseDiscordApplicationConfig(process.env) !== null,
        jobs
      };
    },
    now
  });
}
