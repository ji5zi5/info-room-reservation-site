import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";
import { CLOSED_LIST_NOTIFICATION_KIND, type ClosedPeriodNotificationStatus } from "./closed-period-notifications";
import type {
  DiscordOperationsBoardClosedListStatus,
  DiscordOperationsBoardSnapshot
} from "./discord-operations-board-contracts";
import { getPeriodSummaries } from "./period-settings";
import { getPrismaNotificationSettings } from "./prisma-notification-settings";
import { STUDY_PERIODS } from "./study-periods";

const ACTIONABLE_CLOSED_LIST_STATUSES = ["FAILED", "PENDING_REVIEW", "UNKNOWN"] as const satisfies readonly ClosedPeriodNotificationStatus[];

export async function loadDiscordOperationsBoardSnapshot(input: {
  readonly date: string;
  readonly now: Date;
}): Promise<DiscordOperationsBoardSnapshot> {
  const actor = systemDatabaseActor();
  const recentSince = new Date(input.now.getTime() - 24 * 60 * 60_000);
  const [periods, settings, health] = await Promise.all([
    getPeriodSummaries(input.date, { actor, includeApplicants: true, now: input.now }),
    getPrismaNotificationSettings(),
    withDatabaseContext({
      actor,
      client: prisma,
      operation: async (transaction) => {
        const [
          deliveries,
          adminCommandBacklog,
          interactionBacklog,
          unresolvedDeliveries,
          operationalJobs,
          recentAdminErrors,
          recentInteractionErrors,
          recentDeliveryErrors,
          recentOperationalErrors,
          latestAdminCommand,
          latestInteraction,
          latestDelivery,
          latestAdminAction
        ] = await Promise.all([
          transaction.notificationDelivery.findMany({
            select: { sentAt: true, status: true, studyPeriod: true, updatedAt: true },
            where: { date: input.date, kind: CLOSED_LIST_NOTIFICATION_KIND }
          }),
          transaction.discordAdminCommandJob.count({ where: { status: { in: ["PENDING", "PROCESSING", "RETRY"] } } }),
          transaction.discordInteractionJob.count({ where: { status: { in: ["PENDING", "PROCESSING", "RETRY"] } } }),
          transaction.notificationDelivery.count({
            where: {
              kind: CLOSED_LIST_NOTIFICATION_KIND,
              status: { in: [...ACTIONABLE_CLOSED_LIST_STATUSES] }
            }
          }),
          transaction.operationalJob.findMany({
            orderBy: { job: "asc" },
            select: { backlogCount: true, job: true, status: true }
          }),
          transaction.discordAdminCommandJob.count({ where: { status: "ABANDONED", updatedAt: { gte: recentSince } } }),
          transaction.discordInteractionJob.count({ where: { status: "ABANDONED", updatedAt: { gte: recentSince } } }),
          transaction.notificationDelivery.count({ where: { status: "FAILED", updatedAt: { gte: recentSince } } }),
          transaction.operationalJob.count({ where: { lastAttemptAt: { gte: recentSince }, status: "FAILED" } }),
          transaction.discordAdminCommandJob.findFirst({
            orderBy: { updatedAt: "desc" },
            select: { updatedAt: true },
            where: { status: { in: ["ABANDONED", "STALE", "SUCCEEDED"] } }
          }),
          transaction.discordInteractionJob.findFirst({
            orderBy: { updatedAt: "desc" },
            select: { updatedAt: true },
            where: { status: { in: ["ABANDONED", "STALE", "SUCCEEDED"] } }
          }),
          transaction.notificationDelivery.findFirst({
            orderBy: { updatedAt: "desc" },
            select: { updatedAt: true },
            where: { status: { in: ["FAILED", "SENT", "UNKNOWN"] } }
          }),
          transaction.adminAction.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } })
        ]);
        return {
          adminCommandBacklog,
          deliveries,
          interactionBacklog,
          lastProcessedAt: latestIso([
            latestAdminCommand?.updatedAt,
            latestInteraction?.updatedAt,
            latestDelivery?.updatedAt,
            latestAdminAction?.createdAt
          ]),
          operationalJobs,
          recentErrorCount: recentAdminErrors + recentInteractionErrors + recentDeliveryErrors + recentOperationalErrors,
          unresolvedDeliveries
        };
      }
    })
  ]);
  return {
    adminCommandBacklog: health.adminCommandBacklog,
    closedNotificationsEnabled: settings.closedPeriodNotificationsEnabled,
    date: input.date,
    interactionBacklog: health.interactionBacklog,
    lastProcessedAt: health.lastProcessedAt,
    operationalJobs: health.operationalJobs,
    periods: STUDY_PERIODS.map((studyPeriod) => {
      const period = periods.find((candidate) => candidate.studyPeriod === studyPeriod);
      if (period === undefined) throw new DiscordOperationsBoardPeriodError(studyPeriod);
      const delivery = health.deliveries.find((candidate) => candidate.studyPeriod === studyPeriod);
      return {
        ...period,
        closedListProcessedAt: deliveryProcessedAt(delivery),
        closedListStatus: delivery === undefined ? "NOT_SENT" : parseClosedListStatus(delivery.status)
      };
    }),
    recentErrorCount: health.recentErrorCount,
    reservationNotificationsEnabled: settings.reservationCreatedNotificationsEnabled,
    unresolvedDeliveries: health.unresolvedDeliveries
  };
}

function deliveryProcessedAt(delivery: { readonly sentAt: Date | null; readonly updatedAt: Date } | undefined): string | null {
  return delivery === undefined ? null : (delivery.sentAt ?? delivery.updatedAt).toISOString();
}

function latestIso(values: readonly (Date | undefined)[]): string | null {
  const dates = values.filter((value): value is Date => value !== undefined);
  return dates.length === 0
    ? null
    : new Date(Math.max(...dates.map((date) => date.getTime()))).toISOString();
}

function parseClosedListStatus(status: string): DiscordOperationsBoardClosedListStatus {
  switch (status) {
    case "ABANDONED":
    case "FAILED":
    case "PENDING":
    case "PENDING_REVIEW":
    case "SENDING":
    case "SENT":
    case "UNKNOWN":
      return status;
    default:
      throw new DiscordOperationsBoardDeliveryStatusError(status);
  }
}

class DiscordOperationsBoardPeriodError extends Error {
  public override readonly name = "DiscordOperationsBoardPeriodError";
}

class DiscordOperationsBoardDeliveryStatusError extends Error {
  public constructor(status: string) {
    super(`Invalid Discord operations board delivery status: ${status}`);
    this.name = "DiscordOperationsBoardDeliveryStatusError";
  }
}
