import { CLOSED_LIST_NOTIFICATION_KIND, type ClosedPeriodNotificationStatus } from "./closed-period-notifications";
import { prisma } from "./db";
import { getPeriodSummaries, type PeriodSummary } from "./period-settings";
import {
  getClosedPeriodNotificationReconciliationBacklog,
  toDeliveryRecord
} from "./prisma-notification-repository";
import type { StudyPeriod } from "./study-periods";

export type AdminDashboardPeriod = PeriodSummary & {
  readonly isClosed: boolean;
  readonly notification: {
    readonly attempts: number;
    readonly failureCode: string | null;
    readonly lastError: string | null;
    readonly messageIds: readonly string[];
    readonly nextAttemptAt: string | null;
    readonly sentAt: string | null;
    readonly status: ClosedPeriodNotificationStatus;
    readonly updatedAt: string;
  } | null;
};

export type AdminDashboardNotificationBacklogItem = {
  readonly attempts: number;
  readonly date: string;
  readonly failureCode: string | null;
  readonly lastError: string | null;
  readonly nextAttemptAt: string | null;
  readonly status: "FAILED" | "PENDING_REVIEW" | "UNKNOWN";
  readonly studyPeriod: StudyPeriod;
  readonly updatedAt: string;
};

export type AdminDashboardPayload = {
  readonly notificationBacklog: readonly AdminDashboardNotificationBacklogItem[];
  readonly periods: readonly AdminDashboardPeriod[];
};

export async function getAdminDashboard(date: string, now: Date): Promise<AdminDashboardPayload> {
  const [periods, deliveries, notificationBacklog] = await Promise.all([
    getPeriodSummaries(date, { includeApplicants: true, now }),
    prisma.notificationDelivery.findMany({
      where: {
        date,
        kind: CLOSED_LIST_NOTIFICATION_KIND
      }
    }),
    getClosedPeriodNotificationReconciliationBacklog(now)
  ]);
  const deliveriesByPeriod = new Map(deliveries.map((delivery) => [delivery.studyPeriod, delivery]));
  return {
    notificationBacklog: notificationBacklog.map((delivery) => ({
      ...delivery,
      nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
      updatedAt: delivery.updatedAt.toISOString()
    })),
    periods: periods.map((period) => {
      const delivery = deliveriesByPeriod.get(period.studyPeriod);
      return {
        ...period,
        isClosed: period.windowState === "closed",
        notification: delivery
          ? {
              attempts: delivery.attempts,
              failureCode: delivery.failureCode,
              lastError: delivery.lastError,
              messageIds: toDeliveryRecord(delivery).messageIds ?? [],
              nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
              sentAt: delivery.sentAt ? delivery.sentAt.toISOString() : null,
              status: parseNotificationStatus(delivery.status),
              updatedAt: delivery.updatedAt.toISOString()
            }
          : null
      };
    })
  };
}

function parseNotificationStatus(value: string): ClosedPeriodNotificationStatus {
  switch (value) {
    case "FAILED":
      return "FAILED";
    case "ABANDONED":
      return "ABANDONED";
    case "PENDING":
      return "PENDING";
    case "PENDING_REVIEW":
      return "PENDING_REVIEW";
    case "SENDING":
      return "SENDING";
    case "SENT":
      return "SENT";
    case "UNKNOWN":
      return "UNKNOWN";
    default:
      return "FAILED";
  }
}

export function notificationStatusLabel(status: ClosedPeriodNotificationStatus | null): string {
  switch (status) {
    case "FAILED":
      return "실패";
    case "ABANDONED":
      return "종료";
    case "PENDING":
      return "대기";
    case "PENDING_REVIEW":
      return "확인 대기";
    case "SENDING":
      return "전송 중";
    case "SENT":
      return "전송됨";
    case "UNKNOWN":
      return "확인 필요";
    case null:
      return "대기";
  }
}

export function studyPeriodLabel(studyPeriod: StudyPeriod): string {
  switch (studyPeriod) {
    case "EIGHTH":
      return "8면학";
    case "FIRST":
      return "1면학";
  }
}
