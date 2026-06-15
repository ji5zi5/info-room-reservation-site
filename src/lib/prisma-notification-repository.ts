import { Prisma, type NotificationDelivery, type PeriodSetting } from "@prisma/client";

import { prisma } from "./db";
import { CLOSED_LIST_NOTIFICATION_KIND, selectClosedPeriodNotificationCandidates, staleSendingDeliveryCutoff, type ClosedPeriodCandidate, type ClosedPeriodDeliverySnapshot, type ClosedPeriodNotificationStatus } from "./closed-period-notifications";
import type { ClosedPeriodNotificationDeliveryRecord, ClosedPeriodNotificationDeliveryWrite, ClosedPeriodNotificationPeriod, ClosedPeriodNotificationRepository } from "./closed-period-notification-service";
import { addDays, toKstDate } from "./date";
import { buildDefaultPeriodSetting, type PeriodSettingDefaults } from "./period-settings";
import { STUDY_PERIODS, parseStudyPeriod, type StudyPeriod } from "./study-periods";

type NotificationReservation = { readonly user: { readonly name: string; readonly studentNumber: string } };

const FORCE_CLAIMABLE_STATUSES = ["FAILED", "SENT"] as const, NON_FORCE_CLAIMABLE_STATUSES = ["FAILED"] as const, CLOSED_PERIOD_CATCH_UP_DAYS = 7;

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
  const catchUpFrom = addDays(today, -(CLOSED_PERIOD_CATCH_UP_DAYS - 1));
  const staleSendingBefore = staleSendingDeliveryCutoff(now);
  const [catchUpSettings, actionableDeliveries, activeCatchUpDeliveries] = await Promise.all([
    prisma.periodSetting.findMany({ where: { date: { gte: catchUpFrom, lte: today } } }),
    prisma.notificationDelivery.findMany({
      where: { date: { lte: today }, kind: CLOSED_LIST_NOTIFICATION_KIND, OR: [{ status: "FAILED" }, { status: "SENDING", updatedAt: { lte: staleSendingBefore } }] }
    }),
    prisma.notificationDelivery.findMany({
      where: { date: { gte: catchUpFrom, lte: today }, kind: CLOSED_LIST_NOTIFICATION_KIND, OR: [{ status: "SENT" }, { status: "SENDING", updatedAt: { gt: staleSendingBefore } }] }
    })
  ]);
  const retryPairs = actionableDeliveries.map((delivery) => ({ date: delivery.date, studyPeriod: parseStudyPeriod(delivery.studyPeriod) }));
  const retrySettings =
    retryPairs.length === 0
      ? []
      : await prisma.periodSetting.findMany({ where: { OR: retryPairs } });
  const retrySettingsByPeriod = new Map(retrySettings.map((setting) => [candidateKey(setting.date, parseStudyPeriod(setting.studyPeriod)), setting]));
  const byPeriod = new Map<string, ClosedPeriodCandidate>();
  for (const candidate of withCatchUpDefaultPeriodCandidates(catchUpSettings.map(toCandidate), catchUpFrom, today)) {
    byPeriod.set(candidateKey(candidate.date, candidate.studyPeriod), candidate);
  }
  for (const pair of retryPairs) {
    byPeriod.set(candidateKey(pair.date, pair.studyPeriod), toCandidate(retrySettingsByPeriod.get(candidateKey(pair.date, pair.studyPeriod)) ?? buildDefaultPeriodSetting(pair.date, pair.studyPeriod)));
  }
  return selectClosedPeriodNotificationCandidates({
    deliveries: [...actionableDeliveries, ...activeCatchUpDeliveries].map(toDeliverySnapshot),
    now,
    settings: Array.from(byPeriod.values())
  });
}

const candidateKey = (date: string, studyPeriod: StudyPeriod): string => `${date}:${studyPeriod}`;

function withCatchUpDefaultPeriodCandidates(
  settings: readonly ClosedPeriodCandidate[],
  catchUpFrom: string,
  today: string
): readonly ClosedPeriodCandidate[] {
  const existingPeriods = new Set(settings.map((setting) => candidateKey(setting.date, setting.studyPeriod)));
  const defaults: ClosedPeriodCandidate[] = [];
  for (let date = catchUpFrom; date <= today; date = addDays(date, 1)) {
    for (const studyPeriod of STUDY_PERIODS) {
      if (!existingPeriods.has(candidateKey(date, studyPeriod))) {
        defaults.push(buildDefaultPeriodSetting(date, studyPeriod));
      }
    }
  }
  return [...settings, ...defaults];
}

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
