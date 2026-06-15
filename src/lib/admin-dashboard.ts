import { CLOSED_LIST_NOTIFICATION_KIND, type ClosedPeriodNotificationStatus } from "./closed-period-notifications";
import { prisma } from "./db";
import { getPeriodSummaries, type PeriodSummary } from "./period-settings";
import { toDeliveryRecord } from "./prisma-notification-repository";
import type { StudyPeriod } from "./study-periods";

export type AdminDashboardPeriod = PeriodSummary & {
  readonly isClosed: boolean;
  readonly notification: {
    readonly attempts: number;
    readonly lastError: string | null;
    readonly messageIds: readonly string[];
    readonly sentAt: string | null;
    readonly status: ClosedPeriodNotificationStatus;
    readonly updatedAt: string;
  } | null;
};

export async function getAdminDashboard(date: string, now: Date): Promise<readonly AdminDashboardPeriod[]> {
  const periods = await getPeriodSummaries(date, { includeApplicants: true, now });
  const deliveries = await Promise.all(
    periods.map((period) =>
      prisma.notificationDelivery.findUnique({
        where: {
          date_studyPeriod_kind: {
            date,
            kind: CLOSED_LIST_NOTIFICATION_KIND,
            studyPeriod: period.studyPeriod
          }
        }
      })
    )
  );
  return periods.map((period, index) => {
    const delivery = deliveries[index];
    return {
      ...period,
      isClosed: period.windowState === "closed",
      notification: delivery
        ? {
            attempts: delivery.attempts,
            lastError: delivery.lastError,
            messageIds: toDeliveryRecord(delivery).messageIds ?? [],
            sentAt: delivery.sentAt ? delivery.sentAt.toISOString() : null,
            status: parseNotificationStatus(delivery.status),
            updatedAt: delivery.updatedAt.toISOString()
          }
        : null
    };
  });
}

function parseNotificationStatus(value: string): ClosedPeriodNotificationStatus {
  switch (value) {
    case "FAILED":
      return "FAILED";
    case "SENDING":
      return "SENDING";
    case "SENT":
      return "SENT";
    default:
      return "FAILED";
  }
}

export function notificationStatusLabel(status: ClosedPeriodNotificationStatus | null): string {
  switch (status) {
    case "FAILED":
      return "실패";
    case "SENDING":
      return "전송 중";
    case "SENT":
      return "전송됨";
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
