import { Prisma, type NotificationDelivery, type PeriodSetting } from "@prisma/client";

import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";
import { CLOSED_LIST_NOTIFICATION_KIND, isClosedPeriodForNotification, selectClosedPeriodNotificationCandidates, staleSendingDeliveryCutoff, type ClosedPeriodCandidate, type ClosedPeriodDeliverySnapshot, type ClosedPeriodNotificationStatus } from "./closed-period-notifications";
import type {
  ClosedPeriodNotificationDeliveryRecord,
  ClosedPeriodNotificationDeliveryWrite,
  ClosedPeriodNotificationPeriod,
  ClosedPeriodNotificationReconciliationStatus,
  ClosedPeriodNotificationReconciliationTransition,
  ClosedPeriodNotificationRepository
} from "./closed-period-notification-service";
import { addDays, toKstDate } from "./date";
import { periodSettingReadDates, resolveEffectivePeriodSetting, type PeriodSettingDefaults } from "./period-settings";
import { GLOBAL_PERIOD_SETTINGS_DATE } from "./period-setting-values";
import { STUDY_PERIODS, parseStudyPeriod, type StudyPeriod } from "./study-periods";

const FORCE_CLAIMABLE_STATUSES = ["FAILED", "PENDING"] as const;
const NON_FORCE_CLAIMABLE_STATUSES = ["FAILED", "PENDING"] as const;
const CLOSED_PERIOD_BACKLOG_LOOKBACK_DAYS = 7;
const UNRESOLVED_DELIVERY_STATUSES = ["FAILED", "PENDING_REVIEW", "UNKNOWN"] as const;
const RECONCILIATION_DELIVERY_STATUSES = ["FAILED", "PENDING_REVIEW", "UNKNOWN"] as const;

export type ClosedPeriodNotificationBacklogItem = {
  readonly attempts: number;
  readonly date: string;
  readonly failureCode: string | null;
  readonly lastError: string | null;
  readonly nextAttemptAt: Date | null;
  readonly status: ClosedPeriodNotificationReconciliationStatus;
  readonly studyPeriod: StudyPeriod;
  readonly updatedAt: Date;
};

export const prismaClosedPeriodNotificationRepository: ClosedPeriodNotificationRepository = {
  async getDelivery(input) {
    return withSystemNotificationContext((transaction) => findDeliveryRecord(transaction, input));
  },

  async getPeriod(input) {
    return withSystemNotificationContext(async (transaction) => {
      const settings = await transaction.periodSetting.findMany({
        where: {
          date: { in: [...periodSettingReadDates(input.date)] },
          studyPeriod: input.studyPeriod
        }
      });
      const reservations = await transaction.reservation.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          reason: true,
          user: { select: { name: true, studentNumber: true } }
        },
        where: {
          date: input.date,
          status: "CONFIRMED",
          studyPeriod: input.studyPeriod
        }
      });
      return toNotificationPeriod(
        resolveEffectivePeriodSetting(input.date, input.studyPeriod, settings),
        reservations.map((reservation) => ({
          name: reservation.user.name,
          reason: reservation.reason,
          studentNumber: reservation.user.studentNumber
        }))
      );
    });
  },

  async claimDelivery(input) {
    return withSystemNotificationContext(async (transaction) => {
      const claimedExistingDelivery = await claimExistingDelivery(
        transaction,
        input,
        input.force === true ? FORCE_CLAIMABLE_STATUSES : NON_FORCE_CLAIMABLE_STATUSES
      );
      if (claimedExistingDelivery) {
        return claimedExistingDelivery;
      }

      try {
        const delivery = await transaction.notificationDelivery.create({
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
    });
  },

  async claimDeliveryForReconciliation(input) {
    return withSystemNotificationContext(async (transaction) => {
      const existingDelivery = await findDeliveryRecord(transaction, input);
      if (!existingDelivery || !isReconciliationStatus(existingDelivery.status) || !existingDelivery.updatedAt) {
        return null;
      }
      const result = await transaction.notificationDelivery.updateMany({
        data: {
          attempts: { increment: 1 },
          failureCode: null,
          lastError: null,
          messageIds: "[]",
          nextAttemptAt: null,
          sentAt: null,
          status: "SENDING"
        },
        where: {
          date: input.date,
          kind: CLOSED_LIST_NOTIFICATION_KIND,
          status: existingDelivery.status,
          studyPeriod: input.studyPeriod,
          updatedAt: existingDelivery.updatedAt
        }
      });
      if (result.count !== 1) {
        return null;
      }
      const delivery = await findDeliveryRecord(transaction, input);
      return delivery ? { delivery, previousStatus: existingDelivery.status } : null;
    });
  },

  async resolveDelivery(input) {
    return withSystemNotificationContext(async (transaction) => {
      const existingDelivery = await findDeliveryRecord(transaction, input);
      if (
        !existingDelivery ||
        !isReconciliationStatus(existingDelivery.status) ||
        !existingDelivery.updatedAt ||
        (input.action === "confirm_sent" && existingDelivery.status !== "UNKNOWN")
      ) {
        return null;
      }
      const result = await transaction.notificationDelivery.updateMany({
        data:
          input.action === "confirm_sent"
            ? {
                failureCode: null,
                lastError: null,
                nextAttemptAt: null,
                sentAt: input.now,
                status: "SENT"
              }
            : {
                nextAttemptAt: null,
                sentAt: null,
                status: "ABANDONED"
              },
        where: {
          date: input.date,
          kind: CLOSED_LIST_NOTIFICATION_KIND,
          status: existingDelivery.status,
          studyPeriod: input.studyPeriod,
          updatedAt: existingDelivery.updatedAt
        }
      });
      if (result.count !== 1) {
        return null;
      }
      const delivery = await findDeliveryRecord(transaction, input);
      return delivery ? { delivery, previousStatus: existingDelivery.status } : null;
    });
  },

  async saveDelivery(write) {
    return withSystemNotificationContext(async (transaction) => {
      const result = await transaction.notificationDelivery.updateMany({
        data: {
          failureCode: write.failureCode,
          lastError: write.lastError,
          messageIds: JSON.stringify(write.messageIds),
          nextAttemptAt: write.nextAttemptAt,
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
      const delivery = await findDeliveryRecord(transaction, write);
      return delivery ? { ...delivery, status: write.status } : null;
    });
  }
};

export async function getDueClosedPeriodNotificationCandidates(now: Date): Promise<readonly ClosedPeriodCandidate[]> {
  const today = toKstDate(now);
  const lookbackStart = addDays(today, -(CLOSED_PERIOD_BACKLOG_LOOKBACK_DAYS - 1));
  const staleSendingBefore = staleSendingDeliveryCutoff(now);
  return withSystemNotificationContext(async (transaction) => {
    const [settings, deliveries] = await Promise.all([
      transaction.periodSetting.findMany({
        where: {
          OR: [
            { date: GLOBAL_PERIOD_SETTINGS_DATE },
            { date: { gte: lookbackStart, lte: today } }
          ]
        }
      }),
      transaction.notificationDelivery.findMany({
        where: { date: { gte: lookbackStart, lte: today }, kind: CLOSED_LIST_NOTIFICATION_KIND }
      })
    ]);

    const candidates = buildLookbackCandidates({ lookbackStart, now, settings, today });
    await materializeMissingDeliveries(transaction, { candidates, deliveries, today });
    await transaction.notificationDelivery.updateMany({
      data: {
        lastError: "Discord 전송 결과 확인이 필요합니다.",
        status: "UNKNOWN"
      },
      where: {
        date: { gte: lookbackStart, lte: today },
        kind: CLOSED_LIST_NOTIFICATION_KIND,
        status: "SENDING",
        updatedAt: { lte: staleSendingBefore }
      }
    });
    const currentDeliveries = await transaction.notificationDelivery.findMany({
      where: { date: today, kind: CLOSED_LIST_NOTIFICATION_KIND }
    });
    return selectClosedPeriodNotificationCandidates({
      deliveries: currentDeliveries.map(toDeliverySnapshot),
      now,
      settings: candidates.filter((candidate) => candidate.date === today)
    });
  });
}

export async function getClosedPeriodNotificationBacklogSummary(now: Date): Promise<{
  readonly count: number;
  readonly oldestAt: Date | null;
}> {
  const today = toKstDate(now);
  const lookbackStart = addDays(today, -(CLOSED_PERIOD_BACKLOG_LOOKBACK_DAYS - 1));
  return withSystemNotificationContext(async (transaction) => {
    const deliveries = await transaction.notificationDelivery.findMany({
      orderBy: { createdAt: "asc" },
      take: CLOSED_PERIOD_BACKLOG_LOOKBACK_DAYS * STUDY_PERIODS.length,
      where: {
        date: { gte: lookbackStart, lte: today },
        kind: CLOSED_LIST_NOTIFICATION_KIND,
        status: { in: [...UNRESOLVED_DELIVERY_STATUSES] }
      }
    });
    return {
      count: deliveries.length,
      oldestAt: deliveries.reduce<Date | null>(
        (oldest, delivery) => !oldest || delivery.createdAt < oldest ? delivery.createdAt : oldest,
        null
      )
    };
  });
}

export async function getClosedPeriodNotificationReconciliationBacklog(
  now: Date
): Promise<readonly ClosedPeriodNotificationBacklogItem[]> {
  const today = toKstDate(now);
  const lookbackStart = addDays(today, -(CLOSED_PERIOD_BACKLOG_LOOKBACK_DAYS - 1));
  return withSystemNotificationContext(async (transaction) => {
    const deliveries = await transaction.notificationDelivery.findMany({
      orderBy: [{ date: "asc" }, { studyPeriod: "asc" }],
      take: CLOSED_PERIOD_BACKLOG_LOOKBACK_DAYS * STUDY_PERIODS.length,
      where: {
        date: { gte: lookbackStart, lte: today },
        kind: CLOSED_LIST_NOTIFICATION_KIND,
        status: { in: [...UNRESOLVED_DELIVERY_STATUSES] }
      }
    });
    return deliveries
      .filter(
        (
          delivery
        ): delivery is typeof delivery & {
          readonly status: ClosedPeriodNotificationReconciliationStatus;
        } => isReconciliationStatus(parseDeliveryStatus(delivery.status))
      )
      .map((delivery) => ({
        attempts: delivery.attempts,
        date: delivery.date,
        failureCode: delivery.failureCode,
        lastError: delivery.lastError,
        nextAttemptAt: delivery.nextAttemptAt,
        status: parseDeliveryStatus(delivery.status) as ClosedPeriodNotificationReconciliationStatus,
        studyPeriod: parseStudyPeriod(delivery.studyPeriod),
        updatedAt: delivery.updatedAt
      }))
      .sort(compareBacklogItems);
  });
}

function buildLookbackCandidates(input: {
  readonly lookbackStart: string;
  readonly now: Date;
  readonly settings: readonly PeriodSetting[];
  readonly today: string;
}): readonly ClosedPeriodCandidate[] {
  const candidates: ClosedPeriodCandidate[] = [];
  for (let date = input.lookbackStart; date <= input.today; date = addDays(date, 1)) {
    for (const studyPeriod of STUDY_PERIODS) {
      const setting = resolveEffectivePeriodSetting(date, studyPeriod, input.settings);
      const candidate = toCandidate(setting);
      if (candidate.enabled && isClosedPeriodForNotification(candidate, input.now)) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

async function materializeMissingDeliveries(transaction: Prisma.TransactionClient, input: {
  readonly candidates: readonly ClosedPeriodCandidate[];
  readonly deliveries: readonly NotificationDelivery[];
  readonly today: string;
}): Promise<void> {
  const existingKeys = new Set(input.deliveries.map((delivery) => candidateKey(delivery.date, parseStudyPeriod(delivery.studyPeriod))));
  for (const candidate of input.candidates) {
    if (existingKeys.has(candidateKey(candidate.date, candidate.studyPeriod))) {
      continue;
    }
    try {
      await transaction.notificationDelivery.create({
        data: {
          attempts: 0,
          date: candidate.date,
          kind: CLOSED_LIST_NOTIFICATION_KIND,
          lastError: null,
          messageIds: "[]",
          sentAt: null,
          status: candidate.date === input.today ? "PENDING" : "PENDING_REVIEW",
          studyPeriod: candidate.studyPeriod
        }
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }
  }
}

const candidateKey = (date: string, studyPeriod: StudyPeriod): string => `${date}:${studyPeriod}`;

async function claimExistingDelivery(
  transaction: Prisma.TransactionClient,
  input: { readonly date: string; readonly staleSendingBefore: Date; readonly studyPeriod: StudyPeriod },
  claimableStatuses: readonly ClosedPeriodNotificationStatus[]
): Promise<ClosedPeriodNotificationDeliveryRecord | null> {
  const result = await transaction.notificationDelivery.updateMany({
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
      status: { in: [...claimableStatuses] },
      studyPeriod: input.studyPeriod
    }
  });
  if (result.count !== 1) {
    return null;
  }
  return findDeliveryRecord(transaction, input);
}

async function findDeliveryRecord(
  transaction: Prisma.TransactionClient,
  input: { readonly date: string; readonly studyPeriod: StudyPeriod }
): Promise<ClosedPeriodNotificationDeliveryRecord | null> {
  const delivery = await transaction.notificationDelivery.findUnique({
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
    failureCode: delivery.failureCode,
    kind: delivery.kind,
    lastError: delivery.lastError,
    messageIds: parseMessageIds(delivery.messageIds),
    nextAttemptAt: delivery.nextAttemptAt,
    status: parseDeliveryStatus(delivery.status),
    studyPeriod: parseStudyPeriod(delivery.studyPeriod),
    updatedAt: delivery.updatedAt
  };
}

function toNotificationPeriod(
  setting: PeriodSetting | PeriodSettingDefaults,
  applicants: ClosedPeriodNotificationPeriod["applicants"]
): ClosedPeriodNotificationPeriod {
  return {
    applicants,
    capacity: setting.capacity,
    closeTime: setting.closeTime,
    confirmedCount: applicants.length,
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
    nextAttemptAt: delivery.nextAttemptAt,
    status: parseDeliveryStatus(delivery.status),
    studyPeriod: parseStudyPeriod(delivery.studyPeriod),
    updatedAt: delivery.updatedAt
  };
}

function parseDeliveryStatus(value: string): ClosedPeriodNotificationStatus {
  switch (value) {
    case "FAILED":
    case "ABANDONED":
    case "PENDING":
    case "PENDING_REVIEW":
    case "SENDING":
    case "SENT":
    case "UNKNOWN":
      return value;
    default:
      return "FAILED";
  }
}

function withSystemNotificationContext<TResult>(
  operation: (transaction: Prisma.TransactionClient) => Promise<TResult>
): Promise<TResult> {
  return withDatabaseContext({ actor: systemDatabaseActor(), client: prisma, operation });
}

function isReconciliationStatus(value: ClosedPeriodNotificationStatus): value is ClosedPeriodNotificationReconciliationStatus {
  return RECONCILIATION_DELIVERY_STATUSES.includes(value as ClosedPeriodNotificationReconciliationStatus);
}

function compareBacklogItems(
  left: ClosedPeriodNotificationBacklogItem,
  right: ClosedPeriodNotificationBacklogItem
): number {
  const dateCompare = left.date.localeCompare(right.date);
  if (dateCompare !== 0) {
    return dateCompare;
  }
  return STUDY_PERIODS.indexOf(left.studyPeriod) - STUDY_PERIODS.indexOf(right.studyPeriod);
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
