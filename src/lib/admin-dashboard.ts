import { CLOSED_LIST_NOTIFICATION_KIND } from "./closed-period-notifications";
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
    readonly status: "FAILED" | "SENT";
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
            status: parseNotificationStatus(delivery.status)
          }
        : null
    };
  });
}

function parseNotificationStatus(value: string): "FAILED" | "SENT" {
  switch (value) {
    case "SENT":
      return "SENT";
    case "FAILED":
      return "FAILED";
    default:
      return "FAILED";
  }
}

export function notificationStatusLabel(status: "FAILED" | "SENT" | null): string {
  switch (status) {
    case "FAILED":
      return "실패";
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
