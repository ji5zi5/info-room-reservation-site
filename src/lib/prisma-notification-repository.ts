import { Prisma, type NotificationDelivery, type PeriodSetting } from "@prisma/client";

import { prisma } from "./db";
import { CLOSED_LIST_NOTIFICATION_KIND, selectClosedPeriodNotificationCandidates, staleSendingDeliveryCutoff, type ClosedPeriodCandidate, type ClosedPeriodDeliverySnapshot, type ClosedPeriodNotificationStatus } from "./closed-period-notifications";
import type { ClosedPeriodNotificationDeliveryRecord, ClosedPeriodNotificationDeliveryWrite, ClosedPeriodNotificationPeriod, ClosedPeriodNotificationRepository } from "./closed-period-notification-service";
import { toKstDate } from "./date";
import { buildDefaultPeriodSetting, type PeriodSettingDefaults } from "./period-settings";
import { STUDY_PERIODS, parseStudyPeriod, type StudyPeriod } from "./study-periods";

type NotificationReservation = {
  readonly reason: string | null;
  readonly user: { readonly name: string; readonly studentNumber: string };
};

const FORCE_CLAIMABLE_STATUSES = ["FAILED", "SENT"] as const, NON_FORCE_CLAIMABLE_STATUSES = ["FAILED"] as const;

export const prismaClosedPeriodNotificationRepository: ClosedPeriodNotificationRepository = {
  async getDelivery(input) {
    return findDeliveryRecord(input);
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
    const reservations = await prisma.reservation.findMany({
      include: { user: true },
      orderBy: { createdAt: "asc" },
      where: {
        date: input.date,
        status: "CONFIRMED",
        studyPeriod: input.studyPeriod
      }
    });
    return toNotificationPeriod(setting ?? buildDefaultPeriodSetting(input.date, input.studyPeriod), reservations);
  },

  async claimDelivery(input) {
    const claimedExistingDelivery = await claimExistingDelivery(
      input,
      input.force === true ? FORCE_CLAIMABLE_STATUSES : NON_FORCE_CLAIMABLE_STATUSES
    );
    if (claimedExistingDelivery) {
      return claimedExistingDelivery;
    }

    try {
      const delivery = await prisma.notificationDelivery.create({
        data: {
          attempts: 1,
          date: input.date,
          kind: CLOSED_LIST_NOTIFICATION_KIND,
          lastError: null,
          messageIds: "[]",
          sentAt: null,
          status: "SENDING",
          studyPeriod: input.studyPeriod
        }
      });
      return toDeliveryRecord(delivery);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return null;
      }
      throw error;
    }
  },

  async saveDelivery(write) {
    const result = await prisma.notificationDelivery.updateMany({
      data: {
        lastError: write.lastError,
        messageIds: JSON.stringify(write.messageIds),
        sentAt: write.status === "SENT" ? new Date() : null,
        status: write.status
      },
      where: {
        date: write.date,
        kind: CLOSED_LIST_NOTIFICATION_KIND,
        status: "SENDING",
        studyPeriod: write.studyPeriod,
        updatedAt: write.claimUpdatedAt
      }
    });
    if (result.count !== 1) {
      return null;
    }
    const delivery = await findDeliveryRecord(write);
    return delivery ? { ...delivery, status: write.status } : null;
  }
};

export async function getDueClosedPeriodNotificationCandidates(now: Date): Promise<readonly ClosedPeriodCandidate[]> {
  const today = toKstDate(now);
  const staleSendingBefore = staleSendingDeliveryCutoff(now);
  const [todaySettings, actionableDeliveries, activeTodayDeliveries] = await Promise.all([
    prisma.periodSetting.findMany({ where: { date: today } }),
    prisma.notificationDelivery.findMany({
      where: { date: today, kind: CLOSED_LIST_NOTIFICATION_KIND, OR: [{ status: "FAILED" }, { status: "SENDING", updatedAt: { lte: staleSendingBefore } }] }
    }),
    prisma.notificationDelivery.findMany({
      where: { date: today, kind: CLOSED_LIST_NOTIFICATION_KIND, OR: [{ status: "SENT" }, { status: "SENDING", updatedAt: { gt: staleSendingBefore } }] }
    })
  ]);
  const todayCandidates = todaySettings.map(toCandidate);
  const existingPeriods = new Set(todayCandidates.map((setting) => candidateKey(setting.date, setting.studyPeriod)));
  const defaultTodayCandidates = STUDY_PERIODS.filter((studyPeriod) => !existingPeriods.has(candidateKey(today, studyPeriod))).map((studyPeriod) =>
    buildDefaultPeriodSetting(today, studyPeriod)
  );
  const byPeriod = new Map<string, ClosedPeriodCandidate>();
  for (const candidate of [...todayCandidates, ...defaultTodayCandidates]) {
    byPeriod.set(candidateKey(candidate.date, candidate.studyPeriod), candidate);
  }
  for (const delivery of actionableDeliveries) {
    const studyPeriod = parseStudyPeriod(delivery.studyPeriod);
    const key = candidateKey(delivery.date, studyPeriod);
    byPeriod.set(key, byPeriod.get(key) ?? buildDefaultPeriodSetting(delivery.date, studyPeriod));
  }
  return selectClosedPeriodNotificationCandidates({
    deliveries: [...actionableDeliveries, ...activeTodayDeliveries].map(toDeliverySnapshot),
    now,
    settings: Array.from(byPeriod.values())
  });
}

const candidateKey = (date: string, studyPeriod: StudyPeriod): string => `${date}:${studyPeriod}`;

async function claimExistingDelivery(
  input: { readonly date: string; readonly staleSendingBefore: Date; readonly studyPeriod: StudyPeriod },
  claimableStatuses: readonly ("FAILED" | "SENT")[]
): Promise<ClosedPeriodNotificationDeliveryRecord | null> {
  const result = await prisma.notificationDelivery.updateMany({
    data: {
      attempts: { increment: 1 },
      lastError: null,
      messageIds: "[]",
      sentAt: null,
      status: "SENDING"
    },
    where: {
      date: input.date,
      kind: CLOSED_LIST_NOTIFICATION_KIND,
      OR: [
        { status: { in: [...claimableStatuses] } },
        { status: "SENDING", updatedAt: { lte: input.staleSendingBefore } }
      ],
      studyPeriod: input.studyPeriod
    }
  });
  if (result.count !== 1) {
    return null;
  }
  return findDeliveryRecord(input);
}

async function findDeliveryRecord(input: { readonly date: string; readonly studyPeriod: StudyPeriod }): Promise<ClosedPeriodNotificationDeliveryRecord | null> {
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
}

export function toDeliveryRecord(delivery: NotificationDelivery): ClosedPeriodNotificationDeliveryRecord {
  return {
    date: delivery.date,
    kind: delivery.kind,
    lastError: delivery.lastError,
    messageIds: parseMessageIds(delivery.messageIds),
    status: parseDeliveryStatus(delivery.status),
    studyPeriod: parseStudyPeriod(delivery.studyPeriod),
    updatedAt: delivery.updatedAt
  };
}

function toNotificationPeriod(
  setting: PeriodSetting | PeriodSettingDefaults,
  reservations: readonly NotificationReservation[]
): ClosedPeriodNotificationPeriod {
  return {
    applicants: reservations.map((reservation) => ({
      name: reservation.user.name,
      reason: reservation.reason,
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
}

function toCandidate(setting: PeriodSetting | PeriodSettingDefaults): ClosedPeriodCandidate {
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
    studyPeriod: parseStudyPeriod(delivery.studyPeriod),
    updatedAt: delivery.updatedAt
  };
}

function parseDeliveryStatus(value: string): ClosedPeriodNotificationStatus {
  switch (value) {
    case "FAILED":
    case "SENDING":
    case "SENT":
      return value;
    default:
      return "FAILED";
  }
}

function parseMessageIds(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((messageId): messageId is string => typeof messageId === "string") : [];
  } catch (error) {
    if (error instanceof SyntaxError) {
      return [];
    }
    throw error;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
