import type { NotificationDelivery, PeriodSetting } from "@prisma/client";

import { prisma } from "./db";
import {
  CLOSED_LIST_NOTIFICATION_KIND,
  selectClosedPeriodNotificationCandidates,
  type ClosedPeriodCandidate,
  type ClosedPeriodDeliverySnapshot
} from "./closed-period-notifications";
import type {
  ClosedPeriodNotificationDeliveryRecord,
  ClosedPeriodNotificationDeliveryWrite,
  ClosedPeriodNotificationPeriod,
  ClosedPeriodNotificationRepository
} from "./closed-period-notification-service";
import { toKstDate } from "./date";
import { parseStudyPeriod, type StudyPeriod } from "./study-periods";

export const prismaClosedPeriodNotificationRepository: ClosedPeriodNotificationRepository = {
  async getDelivery(input) {
    const delivery = await prisma.notificationDelivery.findUnique({
      where: {
        date_studyPeriod_kind: {
          date: input.date,
          kind: CLOSED_LIST_NOTIFICATION_KIND,
          studyPeriod: input.studyPeriod
        }
      }
    });
    return delivery ? toDeliveryRecord(delivery) : null;
  },

  async getPeriod(input) {
    const setting = await prisma.periodSetting.findUnique({
      where: {
        date_studyPeriod: {
          date: input.date,
          studyPeriod: input.studyPeriod
        }
      }
    });
    if (!setting) {
      return null;
    }
    const reservations = await prisma.reservation.findMany({
      include: { user: true },
      orderBy: { createdAt: "asc" },
      where: {
        date: input.date,
        status: "CONFIRMED",
        studyPeriod: input.studyPeriod
      }
    });
    return {
      applicants: reservations.map((reservation) => ({
        name: reservation.user.name,
        studentNumber: reservation.user.studentNumber
      })),
      capacity: setting.capacity,
      closeTime: setting.closeTime,
      confirmedCount: reservations.length,
      date: setting.date,
      enabled: setting.enabled,
      openTime: setting.openTime,
      studyPeriod: parseStudyPeriod(setting.studyPeriod)
    };
  },

  async saveDelivery(write) {
    const delivery = await prisma.notificationDelivery.upsert({
      create: {
        attempts: 1,
        date: write.date,
        kind: CLOSED_LIST_NOTIFICATION_KIND,
        lastError: write.lastError,
        messageIds: JSON.stringify(write.messageIds),
        sentAt: write.status === "SENT" ? new Date() : null,
        status: write.status,
        studyPeriod: write.studyPeriod
      },
      update: {
        attempts: { increment: 1 },
        lastError: write.lastError,
        messageIds: JSON.stringify(write.messageIds),
        sentAt: write.status === "SENT" ? new Date() : null,
        status: write.status
      },
      where: {
        date_studyPeriod_kind: {
          date: write.date,
          kind: CLOSED_LIST_NOTIFICATION_KIND,
          studyPeriod: write.studyPeriod
        }
      }
    });
    return toDeliveryRecord(delivery);
  }
};

export async function getDueClosedPeriodNotificationCandidates(now: Date): Promise<readonly ClosedPeriodCandidate[]> {
  const today = toKstDate(now);
  const settings = await prisma.periodSetting.findMany({
    where: {
      date: { lte: today },
      enabled: true
    }
  });
  const dates = Array.from(new Set(settings.map((setting) => setting.date)));
  const deliveries =
    dates.length === 0
      ? []
      : await prisma.notificationDelivery.findMany({
          where: {
            date: { in: dates },
            kind: CLOSED_LIST_NOTIFICATION_KIND
          }
        });
  return selectClosedPeriodNotificationCandidates({
    deliveries: deliveries.map(toDeliverySnapshot),
    now,
    settings: settings.map(toCandidate)
  });
}

export function toDeliveryRecord(delivery: NotificationDelivery): ClosedPeriodNotificationDeliveryRecord {
  return {
    date: delivery.date,
    kind: delivery.kind,
    lastError: delivery.lastError,
    messageIds: parseMessageIds(delivery.messageIds),
    status: parseDeliveryStatus(delivery.status),
    studyPeriod: parseStudyPeriod(delivery.studyPeriod)
  };
}

export function toDeliveryWriteJson(write: ClosedPeriodNotificationDeliveryWrite): string {
  return JSON.stringify(write.messageIds);
}

function toCandidate(setting: PeriodSetting): ClosedPeriodCandidate {
  return {
    capacity: setting.capacity,
    closeTime: setting.closeTime,
    date: setting.date,
    enabled: setting.enabled,
    openTime: setting.openTime,
    studyPeriod: parseStudyPeriod(setting.studyPeriod)
  };
}

function toDeliverySnapshot(delivery: NotificationDelivery): ClosedPeriodDeliverySnapshot {
  return {
    date: delivery.date,
    kind: delivery.kind,
    status: parseDeliveryStatus(delivery.status),
    studyPeriod: parseStudyPeriod(delivery.studyPeriod)
  };
}

function parseDeliveryStatus(value: string): "FAILED" | "SENT" {
  switch (value) {
    case "FAILED":
      return "FAILED";
    case "SENT":
      return "SENT";
    default:
      return "FAILED";
  }
}

function parseMessageIds(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((messageId): messageId is string => typeof messageId === "string");
  } catch (error) {
    if (error instanceof SyntaxError) {
      return [];
    }
    throw error;
  }
}
