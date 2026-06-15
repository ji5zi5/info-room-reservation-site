import { describe, expect, it } from "vitest";

import { createClosedPeriodNotificationService } from "./closed-period-notification-service";
import { createMemoryNotificationRepository, sendingDelivery, testClosedPeriod } from "./closed-period-notification-service-test-utils";

describe("closed period notification service concurrency", () => {
  it("calls the sender once when two same-period attempts overlap", async () => {
    const repository = createMemoryNotificationRepository({ period: testClosedPeriod });
    let senderCallCount = 0;
    const service = createClosedPeriodNotificationService({
      now: new Date("2026-06-12T07:25:00.000Z"),
      repository,
      sender: async () => {
        senderCallCount += 1;
        return { messageIds: [`discord-message-${senderCallCount}`] };
      }
    });

    const results = await Promise.all([
      service.sendClosedPeriod({ date: "2026-06-12", studyPeriod: "EIGHTH" }),
      service.sendClosedPeriod({ date: "2026-06-12", studyPeriod: "EIGHTH" })
    ]);

    expect(senderCallCount).toBe(1);
    expect(results.map((result) => result.kind).sort()).toEqual(["sent", "skipped"]);
  });

  it("skips an in-progress delivery without calling the sender", async () => {
    const repository = createMemoryNotificationRepository({
      delivery: sendingDelivery("2026-06-12T07:20:00.000Z"),
      period: testClosedPeriod
    });
    let senderCallCount = 0;
    const service = createClosedPeriodNotificationService({
      now: new Date("2026-06-12T07:25:00.000Z"),
      repository,
      sender: async () => {
        senderCallCount += 1;
        return { messageIds: ["should-not-send"] };
      }
    });

    const result = await service.sendClosedPeriod({ date: "2026-06-12", force: true, studyPeriod: "EIGHTH" });

    expect(result).toEqual({ kind: "skipped", reason: "already_sent" });
    expect(senderCallCount).toBe(0);
    expect(repository.writes).toEqual([]);
  });

  it("reclaims a stale in-progress delivery before sending", async () => {
    const repository = createMemoryNotificationRepository({
      delivery: sendingDelivery("2026-06-12T07:15:00.000Z"),
      period: testClosedPeriod
    });
    let senderCallCount = 0;
    const service = createClosedPeriodNotificationService({
      now: new Date("2026-06-12T07:25:00.000Z"),
      repository,
      sender: async () => {
        senderCallCount += 1;
        return { messageIds: ["stale-retry-message"] };
      }
    });

    const result = await service.sendClosedPeriod({ date: "2026-06-12", studyPeriod: "EIGHTH" });

    expect(result.kind).toBe("sent");
    expect(senderCallCount).toBe(1);
    expect(repository.writes).toEqual([
      expect.objectContaining({
        date: "2026-06-12",
        lastError: null,
        messageIds: ["stale-retry-message"],
        status: "SENT",
        studyPeriod: "EIGHTH"
      })
    ]);
  });

  it("retries a failed delivery by claiming it before sending", async () => {
    const repository = createMemoryNotificationRepository({
      delivery: { date: "2026-06-12", kind: "CLOSED_LIST", status: "FAILED", studyPeriod: "EIGHTH" },
      period: testClosedPeriod
    });
    let senderCallCount = 0;
    const service = createClosedPeriodNotificationService({
      now: new Date("2026-06-12T07:25:00.000Z"),
      repository,
      sender: async () => {
        senderCallCount += 1;
        return { messageIds: ["retry-message"] };
      }
    });

    const result = await service.sendClosedPeriod({ date: "2026-06-12", studyPeriod: "EIGHTH" });

    expect(result.kind).toBe("sent");
    expect(senderCallCount).toBe(1);
    expect(repository.writes).toEqual([
      expect.objectContaining({
        date: "2026-06-12",
        lastError: null,
        messageIds: ["retry-message"],
        status: "SENT",
        studyPeriod: "EIGHTH"
      })
    ]);
  });

  it("retries a sent delivery when force is true", async () => {
    const repository = createMemoryNotificationRepository({
      delivery: { date: "2026-06-12", kind: "CLOSED_LIST", status: "SENT", studyPeriod: "EIGHTH" },
      period: testClosedPeriod
    });
    let senderCallCount = 0;
    const service = createClosedPeriodNotificationService({
      now: new Date("2026-06-12T07:25:00.000Z"),
      repository,
      sender: async () => {
        senderCallCount += 1;
        return { messageIds: ["forced-message"] };
      }
    });

    const result = await service.sendClosedPeriod({ date: "2026-06-12", force: true, studyPeriod: "EIGHTH" });

    expect(result.kind).toBe("sent");
    expect(senderCallCount).toBe(1);
    expect(repository.writes).toEqual([
      expect.objectContaining({
        date: "2026-06-12",
        lastError: null,
        messageIds: ["forced-message"],
        status: "SENT",
        studyPeriod: "EIGHTH"
      })
    ]);
  });

  it("does not overwrite a newer delivery when an old stale claim finishes late", async () => {
    const staleClaimTime = new Date("2026-06-12T07:25:00.000Z");
    const newerFinalTime = new Date("2026-06-12T07:26:00.000Z");
    const repository = createMemoryNotificationRepository({
      delivery: sendingDelivery("2026-06-12T07:15:00.000Z"),
      period: testClosedPeriod
    });
    const service = createClosedPeriodNotificationService({
      now: staleClaimTime,
      repository: {
        ...repository,
        async saveDelivery(write) {
          if (
            write.claimUpdatedAt.getTime() !== staleClaimTime.getTime() ||
            repository.currentDelivery?.status !== "SENDING" ||
            repository.currentDelivery.updatedAt?.getTime() !== staleClaimTime.getTime()
          ) {
            return null;
          }
          return repository.saveDelivery(write);
        }
      },
      sender: async () => {
        repository.replaceDelivery({
          date: "2026-06-12",
          kind: "CLOSED_LIST",
          lastError: null,
          messageIds: ["newer-message"],
          status: "SENT",
          studyPeriod: "EIGHTH",
          updatedAt: newerFinalTime
        });
        return { messageIds: ["old-message"] };
      }
    });

    const result = await service.sendClosedPeriod({ date: "2026-06-12", studyPeriod: "EIGHTH" });

    expect(result).toEqual({ kind: "skipped", reason: "already_sent" });
    expect(repository.currentDelivery?.messageIds).toEqual(["newer-message"]);
  });
});
