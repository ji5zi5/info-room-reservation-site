import type {
  ClosedPeriodNotificationDeliveryRecord,
  ClosedPeriodNotificationDeliveryWrite,
  ClosedPeriodNotificationPeriod,
  ClosedPeriodNotificationRepository
} from "./closed-period-notification-service";
import type { ClosedPeriodNotificationStatus } from "./closed-period-notifications";
import type { StudyPeriod } from "./study-periods";

export const testClosedPeriod = {
  applicants: [{ name: "源?꾩쑄", studentNumber: "26001" }],
  capacity: 10,
  closeTime: "16:20",
  confirmedCount: 1,
  date: "2026-06-12",
  enabled: true,
  openTime: "13:00",
  studyPeriod: "EIGHTH"
} satisfies ClosedPeriodNotificationPeriod;

export type TestDelivery = ClosedPeriodNotificationDeliveryRecord & {
  readonly date: string;
  readonly kind: string;
  readonly status: ClosedPeriodNotificationStatus;
  readonly studyPeriod: StudyPeriod;
};

export function sendingDelivery(updatedAt: string): TestDelivery {
  return {
    date: "2026-06-12",
    kind: "CLOSED_LIST",
    status: "SENDING",
    studyPeriod: "EIGHTH",
    updatedAt: new Date(updatedAt)
  };
}

export function createMemoryNotificationRepository(input: {
  readonly delivery?: TestDelivery;
  readonly period: ClosedPeriodNotificationPeriod;
}): ClosedPeriodNotificationRepository & {
  readonly currentDelivery: TestDelivery | null;
  readonly replaceDelivery: (delivery: TestDelivery) => void;
  readonly writes: readonly ClosedPeriodNotificationDeliveryWrite[];
} {
  const writes: ClosedPeriodNotificationDeliveryWrite[] = [];
  let delivery = input.delivery ?? null;
  return {
    async claimDelivery(request) {
      if (delivery?.status === "SENDING" && !isTestStaleSendingDelivery(delivery, request.staleSendingBefore)) {
        return null;
      }
      if (delivery?.status === "SENT" && request.force !== true) {
        return null;
      }
      delivery = {
        date: request.date,
        kind: "CLOSED_LIST",
        status: "SENDING",
        studyPeriod: request.studyPeriod,
        updatedAt: new Date("2026-06-12T07:25:00.000Z")
      };
      return delivery;
    },
    async getDelivery() {
      return delivery;
    },
    async getPeriod() {
      return input.period;
    },
    get currentDelivery() {
      return delivery;
    },
    replaceDelivery(nextDelivery) {
      delivery = nextDelivery;
    },
    async saveDelivery(write) {
      if (
        delivery?.status !== "SENDING" ||
        delivery.updatedAt === undefined ||
        delivery.updatedAt.getTime() !== write.claimUpdatedAt.getTime()
      ) {
        return null;
      }
      writes.push(write);
      const finalDelivery = {
        date: write.date,
        kind: "CLOSED_LIST",
        lastError: write.lastError,
        messageIds: write.messageIds,
        status: write.status,
        studyPeriod: write.studyPeriod,
        updatedAt: new Date("2026-06-12T07:25:01.000Z")
      } satisfies TestDelivery;
      delivery = finalDelivery;
      return finalDelivery;
    },
    writes
  };
}

function isTestStaleSendingDelivery(delivery: TestDelivery, staleSendingBefore: Date): boolean {
  return (
    delivery.status === "SENDING" &&
    delivery.updatedAt !== undefined &&
    delivery.updatedAt.getTime() <= staleSendingBefore.getTime()
  );
}
