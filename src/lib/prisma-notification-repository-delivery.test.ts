import { beforeEach, describe, expect, it } from "vitest";

import { CLOSED_LIST_NOTIFICATION_KIND } from "./closed-period-notifications";
import type { ClosedPeriodNotificationDeliveryWrite } from "./closed-period-notification-service";
import { delivery, prismaKnownError, prismaMocks } from "./prisma-notification-repository-test-utils";
import { prismaClosedPeriodNotificationRepository } from "./prisma-notification-repository";

beforeEach(() => {
  prismaMocks.reset();
});

describe("Prisma closed-period notification delivery claims", () => {
  it("returns null when saveDelivery loses the sending-row compare-and-swap", async () => {
    const write = {
      claimUpdatedAt: new Date("2026-06-12T07:21:00.000Z"),
      date: "2026-06-12",
      failureCode: null,
      lastError: null,
      messageIds: ["123"],
      nextAttemptAt: null,
      status: "SENT",
      studyPeriod: "EIGHTH"
    } satisfies ClosedPeriodNotificationDeliveryWrite;

    const deliveryRecord = await prismaClosedPeriodNotificationRepository.saveDelivery(write);

    expect(deliveryRecord).toBeNull();
    expect(prismaMocks.notificationDeliveryFindUnique).not.toHaveBeenCalled();
  });

  it("creates a sending claim when no delivery row exists", async () => {
    const claim = await prismaClosedPeriodNotificationRepository.claimDelivery({
      date: "2026-06-12",
      staleSendingBefore: new Date("2026-06-12T07:15:00.000Z"),
      studyPeriod: "EIGHTH"
    });

    expect(claim).toMatchObject({
      date: "2026-06-12",
      kind: CLOSED_LIST_NOTIFICATION_KIND,
      status: "SENDING",
      studyPeriod: "EIGHTH"
    });
    expect(prismaMocks.notificationDeliveryCreate).toHaveBeenCalledTimes(1);
    expect(prismaMocks.notificationDeliveriesStore).toHaveLength(1);
  });

  it("returns null when creating a sending claim loses a unique race", async () => {
    prismaMocks.notificationDeliveryCreate.mockRejectedValueOnce(prismaKnownError("P2002"));

    const claim = await prismaClosedPeriodNotificationRepository.claimDelivery({
      date: "2026-06-12",
      staleSendingBefore: new Date("2026-06-12T07:15:00.000Z"),
      studyPeriod: "EIGHTH"
    });

    expect(claim).toBeNull();
  });

  it("claims failed deliveries but leaves stale sending and sent deliveries unresolved", async () => {
    prismaMocks.notificationDeliveriesStore.push(
      delivery({
        date: "2026-06-10",
        status: "FAILED",
        studyPeriod: "EIGHTH",
        updatedAt: new Date("2026-06-10T07:20:00.000Z")
      }),
      delivery({
        date: "2026-06-11",
        status: "SENDING",
        studyPeriod: "FIRST",
        updatedAt: new Date("2026-06-12T07:10:00.000Z")
      }),
      delivery({
        date: "2026-06-12",
        status: "SENT",
        studyPeriod: "EIGHTH",
        updatedAt: new Date("2026-06-12T07:20:00.000Z")
      })
    );

    await expect(
      prismaClosedPeriodNotificationRepository.claimDelivery({
        date: "2026-06-10",
        staleSendingBefore: new Date("2026-06-12T07:15:00.000Z"),
        studyPeriod: "EIGHTH"
      })
    ).resolves.toMatchObject({ date: "2026-06-10", status: "SENDING" });
    await expect(
      prismaClosedPeriodNotificationRepository.claimDelivery({
        date: "2026-06-11",
        staleSendingBefore: new Date("2026-06-12T07:15:00.000Z"),
        studyPeriod: "FIRST"
      })
    ).resolves.toBeNull();
    await expect(
      prismaClosedPeriodNotificationRepository.claimDelivery({
        date: "2026-06-12",
        staleSendingBefore: new Date("2026-06-12T07:15:00.000Z"),
        studyPeriod: "EIGHTH"
      })
    ).resolves.toBeNull();
    await expect(
      prismaClosedPeriodNotificationRepository.claimDelivery({
        date: "2026-06-12",
        force: true,
        staleSendingBefore: new Date("2026-06-12T07:15:00.000Z"),
        studyPeriod: "EIGHTH"
      })
    ).resolves.toBeNull();
  });

  it("saves a delivery when the sending-row compare-and-swap matches", async () => {
    const claimTime = new Date("2026-06-12T07:21:00.000Z");
    prismaMocks.notificationDeliveriesStore.push(
      delivery({ date: "2026-06-12", status: "SENDING", studyPeriod: "EIGHTH", updatedAt: claimTime })
    );

    const deliveryRecord = await prismaClosedPeriodNotificationRepository.saveDelivery({
      claimUpdatedAt: claimTime,
      date: "2026-06-12",
      failureCode: null,
      lastError: null,
      messageIds: ["123"],
      nextAttemptAt: null,
      status: "SENT",
      studyPeriod: "EIGHTH"
    });

    expect(deliveryRecord).toMatchObject({
      date: "2026-06-12",
      messageIds: ["123"],
      status: "SENT",
      studyPeriod: "EIGHTH"
    });
    expect(prismaMocks.notificationDeliveryFindUnique).toHaveBeenCalledTimes(1);
  });

  it("claims an unresolved delivery exactly once for explicit reconciliation", async () => {
    prismaMocks.notificationDeliveriesStore.push(
      delivery({
        date: "2026-06-12",
        status: "UNKNOWN",
        studyPeriod: "EIGHTH",
        updatedAt: new Date("2026-06-12T07:20:00.000Z")
      })
    );

    await expect(
      prismaClosedPeriodNotificationRepository.claimDeliveryForReconciliation({
        date: "2026-06-12",
        studyPeriod: "EIGHTH"
      })
    ).resolves.toMatchObject({
      delivery: { status: "SENDING" },
      previousStatus: "UNKNOWN"
    });
    await expect(
      prismaClosedPeriodNotificationRepository.claimDeliveryForReconciliation({
        date: "2026-06-12",
        studyPeriod: "EIGHTH"
      })
    ).resolves.toBeNull();
  });

  it("confirms only an unknown delivery as sent", async () => {
    prismaMocks.notificationDeliveriesStore.push(
      delivery({
        date: "2026-06-12",
        status: "UNKNOWN",
        studyPeriod: "EIGHTH",
        updatedAt: new Date("2026-06-12T07:20:00.000Z")
      })
    );

    await expect(
      prismaClosedPeriodNotificationRepository.resolveDelivery({
        action: "confirm_sent",
        date: "2026-06-12",
        now: new Date("2026-06-12T07:25:00.000Z"),
        studyPeriod: "EIGHTH"
      })
    ).resolves.toMatchObject({
      delivery: { status: "SENT" },
      previousStatus: "UNKNOWN"
    });
    await expect(
      prismaClosedPeriodNotificationRepository.resolveDelivery({
        action: "confirm_sent",
        date: "2026-06-12",
        now: new Date("2026-06-12T07:25:01.000Z"),
        studyPeriod: "EIGHTH"
      })
    ).resolves.toBeNull();
  });

  it("abandons a prior delivery that requires operator review", async () => {
    prismaMocks.notificationDeliveriesStore.push(
      delivery({
        date: "2026-06-11",
        status: "PENDING_REVIEW",
        studyPeriod: "FIRST",
        updatedAt: new Date("2026-06-12T07:20:00.000Z")
      })
    );

    await expect(
      prismaClosedPeriodNotificationRepository.resolveDelivery({
        action: "abandon",
        date: "2026-06-11",
        now: new Date("2026-06-12T07:25:00.000Z"),
        studyPeriod: "FIRST"
      })
    ).resolves.toMatchObject({
      delivery: { status: "ABANDONED" },
      previousStatus: "PENDING_REVIEW"
    });
  });
});
