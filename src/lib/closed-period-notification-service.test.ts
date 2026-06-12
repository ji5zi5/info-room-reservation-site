import { describe, expect, it } from "vitest";

import {
  createClosedPeriodNotificationService,
  type ClosedPeriodNotificationDeliveryWrite,
  type ClosedPeriodNotificationPeriod,
  type ClosedPeriodNotificationRepository
} from "./closed-period-notification-service";

const closedPeriod = {
  applicants: [{ name: "김도윤", studentNumber: "26001" }],
  capacity: 10,
  closeTime: "16:20",
  confirmedCount: 1,
  date: "2026-06-12",
  enabled: true,
  openTime: "13:00",
  studyPeriod: "EIGHTH"
} satisfies ClosedPeriodNotificationPeriod;

describe("closed period notification service", () => {
  it("sends a closed list and stores the Discord message id", async () => {
    const repository = createMemoryRepository({ period: closedPeriod });
    const sentTitles: string[] = [];
    const service = createClosedPeriodNotificationService({
      now: new Date("2026-06-12T07:25:00.000Z"),
      repository,
      sender: async (payload) => {
        sentTitles.push(payload.embeds[0]?.title ?? "");
        return { messageIds: ["discord-message-1"] };
      }
    });

    const result = await service.sendClosedPeriod({ date: "2026-06-12", studyPeriod: "EIGHTH" });

    expect(result.kind).toBe("sent");
    expect(sentTitles).toEqual(["8면학 마감 신청자 명단"]);
    expect(repository.writes).toEqual([
      {
        date: "2026-06-12",
        lastError: null,
        messageIds: ["discord-message-1"],
        status: "SENT",
        studyPeriod: "EIGHTH"
      }
    ]);
  });

  it("skips an already-sent period unless force is true", async () => {
    const repository = createMemoryRepository({
      delivery: { date: "2026-06-12", kind: "CLOSED_LIST", status: "SENT", studyPeriod: "EIGHTH" },
      period: closedPeriod
    });
    const service = createClosedPeriodNotificationService({
      now: new Date("2026-06-12T07:25:00.000Z"),
      repository,
      sender: async () => ({ messageIds: ["should-not-send"] })
    });

    const result = await service.sendClosedPeriod({ date: "2026-06-12", studyPeriod: "EIGHTH" });

    expect(result).toEqual({ kind: "skipped", reason: "already_sent" });
    expect(repository.writes).toEqual([]);
  });

  it("records a failed delivery when Discord rejects the request", async () => {
    const repository = createMemoryRepository({ period: closedPeriod });
    const service = createClosedPeriodNotificationService({
      now: new Date("2026-06-12T07:25:00.000Z"),
      repository,
      sender: async () => {
        throw new Error("discord 500");
      }
    });

    const result = await service.sendClosedPeriod({ date: "2026-06-12", studyPeriod: "EIGHTH" });

    expect(result.kind).toBe("failed");
    expect(repository.writes).toEqual([
      {
        date: "2026-06-12",
        lastError: "discord 500",
        messageIds: [],
        status: "FAILED",
        studyPeriod: "EIGHTH"
      }
    ]);
  });
});

function createMemoryRepository(input: {
  readonly delivery?: {
    readonly date: string;
    readonly kind: string;
    readonly status: "FAILED" | "SENT";
    readonly studyPeriod: "EIGHTH" | "FIRST";
  };
  readonly period: ClosedPeriodNotificationPeriod;
}): ClosedPeriodNotificationRepository & { readonly writes: readonly ClosedPeriodNotificationDeliveryWrite[] } {
  const writes: ClosedPeriodNotificationDeliveryWrite[] = [];
  return {
    async getDelivery() {
      return input.delivery ?? null;
    },
    async getPeriod() {
      return input.period;
    },
    async saveDelivery(write) {
      writes.push(write);
      return { ...write, kind: "CLOSED_LIST" };
    },
    writes
  };
}
