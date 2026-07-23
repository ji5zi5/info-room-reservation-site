import { describe, expect, it } from "vitest";

import {
  createClosedPeriodNotificationService,
  type ClosedPeriodNotificationDeliveryRecord,
  type ClosedPeriodNotificationDeliveryWrite,
  type ClosedPeriodNotificationReconciliationStatus,
  type ClosedPeriodNotificationRepository,
  type ClosedPeriodNotificationService
} from "./closed-period-notification-service";
import type { ClosedPeriodNotificationStatus } from "./closed-period-notifications";
import { testClosedPeriod } from "./closed-period-notification-service-test-utils";

describe("closed period notification reconciliation", () => {
  it("confirms an unknown delivery without posting to Discord again", async () => {
    const harness = createReconciliationHarness("UNKNOWN");
    const service = createService(harness);

    const result = await service.reconcileClosedPeriod({
      action: "confirm_sent",
      date: testClosedPeriod.date,
      studyPeriod: testClosedPeriod.studyPeriod
    });

    expect(result).toMatchObject({ kind: "confirmed", previousStatus: "UNKNOWN" });
    expect(harness.senderCalls).toBe(0);
    expect(harness.currentDelivery.status).toBe("SENT");
  });

  it("explicitly retries a failed delivery after claiming it", async () => {
    const harness = createReconciliationHarness("FAILED");
    const service = createService(harness);

    const result = await service.reconcileClosedPeriod({
      action: "retry",
      date: testClosedPeriod.date,
      studyPeriod: testClosedPeriod.studyPeriod
    });

    expect(result).toMatchObject({ kind: "sent", previousStatus: "FAILED" });
    expect(harness.senderCalls).toBe(1);
    expect(harness.currentDelivery).toMatchObject({
      messageIds: ["reconciled-message"],
      status: "SENT"
    });
  });

  it("abandons a prior missing delivery without posting to Discord", async () => {
    const harness = createReconciliationHarness("PENDING_REVIEW");
    const service = createService(harness);

    const result = await service.reconcileClosedPeriod({
      action: "abandon",
      date: testClosedPeriod.date,
      studyPeriod: testClosedPeriod.studyPeriod
    });

    expect(result).toMatchObject({ kind: "abandoned", previousStatus: "PENDING_REVIEW" });
    expect(harness.senderCalls).toBe(0);
    expect(harness.currentDelivery.status).toBe("ABANDONED");
  });

  it("rejects confirm-sent for a delivery with a known failure", async () => {
    const harness = createReconciliationHarness("FAILED");
    const service = createService(harness);

    const result = await service.reconcileClosedPeriod({
      action: "confirm_sent",
      date: testClosedPeriod.date,
      studyPeriod: testClosedPeriod.studyPeriod
    });

    expect(result).toEqual({ kind: "conflict" });
    expect(harness.senderCalls).toBe(0);
    expect(harness.currentDelivery.status).toBe("FAILED");
  });

  it("allows only one winner when two reconciliation actions overlap", async () => {
    const harness = createReconciliationHarness("UNKNOWN");
    const service = createService(harness);

    const results = await Promise.all([
      service.reconcileClosedPeriod({
        action: "retry",
        date: testClosedPeriod.date,
        studyPeriod: testClosedPeriod.studyPeriod
      }),
      service.reconcileClosedPeriod({
        action: "abandon",
        date: testClosedPeriod.date,
        studyPeriod: testClosedPeriod.studyPeriod
      })
    ]);

    expect(results.filter((result) => result.kind !== "conflict")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "conflict")).toHaveLength(1);
    expect(harness.senderCalls).toBeLessThanOrEqual(1);
  });
});

function createService(harness: ReconciliationHarness): ClosedPeriodNotificationService {
  return createClosedPeriodNotificationService({
    now: new Date("2026-06-12T07:25:00.000Z"),
    repository: harness.repository,
    sender: async () => {
      harness.recordSenderCall();
      return { messageIds: ["reconciled-message"] };
    }
  });
}

type ReconciliationHarness = {
  readonly currentDelivery: MutableDelivery;
  readonly recordSenderCall: () => void;
  readonly repository: ClosedPeriodNotificationRepository;
  readonly senderCalls: number;
};

type MutableDelivery = {
  date: string;
  failureCode: string | null;
  kind: string;
  lastError: string | null;
  messageIds: readonly string[];
  nextAttemptAt: Date | null;
  status: ClosedPeriodNotificationStatus;
  studyPeriod: "EIGHTH" | "FIRST";
  updatedAt: Date;
};

function createReconciliationHarness(initialStatus: ClosedPeriodNotificationStatus): ReconciliationHarness {
  let senderCalls = 0;
  const delivery: MutableDelivery = {
    date: testClosedPeriod.date,
    failureCode: initialStatus === "FAILED" ? "discord_http_500" : null,
    kind: "CLOSED_LIST",
    lastError: initialStatus === "FAILED" ? "Discord request failed" : null,
    messageIds: [],
    nextAttemptAt: null,
    status: initialStatus,
    studyPeriod: testClosedPeriod.studyPeriod,
    updatedAt: new Date("2026-06-12T07:20:00.000Z")
  };

  const repository: ClosedPeriodNotificationRepository = {
    async claimDelivery() {
      return null;
    },
    async claimDeliveryForReconciliation() {
      if (!isReconciliationStatus(delivery.status)) {
        return null;
      }
      const previousStatus = delivery.status;
      delivery.status = "SENDING";
      delivery.updatedAt = new Date("2026-06-12T07:25:00.000Z");
      return { delivery: { ...delivery }, previousStatus };
    },
    async getDelivery() {
      return { ...delivery };
    },
    async getPeriod() {
      return testClosedPeriod;
    },
    async resolveDelivery(input) {
      if (!isReconciliationStatus(delivery.status)) {
        return null;
      }
      const allowed =
        input.action === "confirm_sent"
          ? delivery.status === "UNKNOWN"
          : true;
      if (!allowed) {
        return null;
      }
      const previousStatus = delivery.status;
      delivery.status = input.action === "confirm_sent" ? "SENT" : "ABANDONED";
      delivery.updatedAt = new Date("2026-06-12T07:25:01.000Z");
      return { delivery: { ...delivery }, previousStatus };
    },
    async saveDelivery(write: ClosedPeriodNotificationDeliveryWrite) {
      if (
        delivery.status !== "SENDING" ||
        delivery.updatedAt.getTime() !== write.claimUpdatedAt.getTime()
      ) {
        return null;
      }
      delivery.failureCode = write.failureCode;
      delivery.lastError = write.lastError;
      delivery.messageIds = write.messageIds;
      delivery.nextAttemptAt = write.nextAttemptAt;
      delivery.status = write.status;
      delivery.updatedAt = new Date("2026-06-12T07:25:01.000Z");
      return { ...delivery, status: write.status };
    }
  };

  return {
    get currentDelivery() {
      return delivery;
    },
    recordSenderCall() {
      senderCalls += 1;
    },
    repository,
    get senderCalls() {
      return senderCalls;
    }
  };
}

function isReconciliationStatus(
  status: ClosedPeriodNotificationStatus
): status is ClosedPeriodNotificationReconciliationStatus {
  return status === "FAILED" || status === "PENDING_REVIEW" || status === "UNKNOWN";
}
