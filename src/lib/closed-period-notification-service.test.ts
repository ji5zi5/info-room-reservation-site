import { describe, expect, it } from "vitest";

import { createClosedPeriodNotificationService } from "./closed-period-notification-service";
import { createMemoryNotificationRepository, testClosedPeriod } from "./closed-period-notification-service-test-utils";
import { DiscordWebhookDeliveryError } from "./discord-notifications";

describe("closed period notification service", () => {
  it("sends a closed list and stores the Discord message id", async () => {
    const repository = createMemoryNotificationRepository({ period: testClosedPeriod });
    const sentTitles: string[] = [];
    const sentPayloads: string[] = [];
    const service = createClosedPeriodNotificationService({
      now: new Date("2026-06-12T07:25:00.000Z"),
      repository,
      sender: async (payload) => {
        sentTitles.push(payload.embeds[0]?.title ?? "");
        sentPayloads.push(JSON.stringify(payload));
        return { messageIds: ["discord-message-1"] };
      }
    });

    const result = await service.sendClosedPeriod({ date: "2026-06-12", studyPeriod: "EIGHTH" });

    expect(result.kind).toBe("sent");
    expect(sentTitles).toEqual(["8면학 마감 알림"]);
    expect(sentPayloads[0]).not.toContain("26001");
    expect(sentPayloads[0]).not.toContain("자습");
    expect(repository.writes).toEqual([
      expect.objectContaining({
        date: "2026-06-12",
        lastError: null,
        messageIds: ["discord-message-1"],
        status: "SENT",
        studyPeriod: "EIGHTH"
      })
    ]);
  });

  it("skips an already-sent period unless force is true", async () => {
    const repository = createMemoryNotificationRepository({
      delivery: { date: "2026-06-12", kind: "CLOSED_LIST", status: "SENT", studyPeriod: "EIGHTH" },
      period: testClosedPeriod
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
    const repository = createMemoryNotificationRepository({ period: testClosedPeriod });
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
      expect.objectContaining({
        date: "2026-06-12",
        lastError: "discord 500",
        messageIds: [],
        status: "FAILED",
        studyPeriod: "EIGHTH"
      })
    ]);
  });

  it("records an unknown delivery instead of retrying an ambiguous timeout", async () => {
    const repository = createMemoryNotificationRepository({ period: testClosedPeriod });
    const service = createClosedPeriodNotificationService({
      now: new Date("2026-06-12T07:25:00.000Z"),
      repository,
      sender: async () => {
        throw new DiscordWebhookDeliveryError({
          code: "discord_timeout",
          message: "Discord response timed out",
          outcome: "UNKNOWN"
        });
      }
    });

    const result = await service.sendClosedPeriod({ date: "2026-06-12", studyPeriod: "EIGHTH" });

    expect(result.kind).toBe("unknown");
    expect(repository.writes).toEqual([
      expect.objectContaining({
        failureCode: "discord_timeout",
        nextAttemptAt: null,
        status: "UNKNOWN"
      })
    ]);
  });

  it("redacts Discord webhook tokens from stored failure errors", async () => {
    const repository = createMemoryNotificationRepository({ period: testClosedPeriod });
    const service = createClosedPeriodNotificationService({
      now: new Date("2026-06-12T07:25:00.000Z"),
      repository,
      sender: async () => {
        throw new Error(
          "Request failed: POST https://discord.com/api/webhooks/123/secret-token?wait=true 401 Unauthorized"
        );
      }
    });

    const result = await service.sendClosedPeriod({ date: "2026-06-12", studyPeriod: "EIGHTH" });

    expect(result.kind).toBe("failed");
    expect(repository.writes[0]?.lastError).toBe(
      "Request failed: POST https://discord.com/api/webhooks/123/[redacted] 401 Unauthorized"
    );
    expect(repository.writes[0]?.lastError).not.toContain("secret-token");
  });
});
