import { TimeoutError } from "ky";
import { describe, expect, it } from "vitest";

import {
  buildClosedPeriodDiscordPayload,
  buildDiscordWebhookExecuteUrl,
  buildReservationCreatedDiscordPayload,
  classifyDiscordWebhookError,
  type ClosedPeriodNotificationInput
} from "./discord-notifications";

const baseInput = {
  capacity: 10,
  closeTime: "16:20",
  confirmedCount: 2,
  date: "2026-06-12",
  studyPeriod: "EIGHTH"
} satisfies ClosedPeriodNotificationInput;

describe("Discord closed-period notification payload", () => {
  it("builds an aggregate eighth-period closure without student identity or reasons", () => {
    const payload = buildClosedPeriodDiscordPayload(baseInput);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0]?.title).toBe("8면학 마감 알림");
    expect(payload.embeds[0]?.description).toContain("2026-06-12");
    expect(payload.embeds[0]?.description).toContain("2/10명");
    expect(payload.embeds[0]?.fields).toEqual([
      { inline: false, name: "전송 ID", value: "closed-period:2026-06-12:EIGHTH" }
    ]);
  });

  it("uses the same aggregate shape for an empty closed period", () => {
    const payload = buildClosedPeriodDiscordPayload({ ...baseInput, confirmedCount: 0 });

    expect(payload.embeds[0]?.fields[0]).toEqual({
      inline: false,
      name: "전송 ID",
      value: "closed-period:2026-06-12:EIGHTH"
    });
  });

  it("keeps one reference field when the aggregate count changes", () => {
    const payload = buildClosedPeriodDiscordPayload({ ...baseInput, capacity: 100, confirmedCount: 80 });

    expect(payload.embeds[0]?.fields).toHaveLength(1);
    expect(payload.embeds[0]?.description).toContain("80/100명");
  });
});

describe("Discord webhook failure classification", () => {
  it("treats response timeouts as an unknown delivery outcome", () => {
    const error = classifyDiscordWebhookError(
      new TimeoutError(new Request("https://discord.com/api/webhooks/1/token", { method: "POST" })),
      new Date("2026-06-12T07:25:00.000Z")
    );

    expect(error).toMatchObject({ code: "discord_timeout", outcome: "UNKNOWN", retryAt: null });
  });

  it("keeps a generic application failure retryable after one minute", () => {
    const error = classifyDiscordWebhookError(
      new Error("discord rejected payload"),
      new Date("2026-06-12T07:25:00.000Z")
    );

    expect(error).toMatchObject({
      code: "discord_send_failed",
      outcome: "FAILED",
      retryAt: new Date("2026-06-12T07:26:00.000Z")
    });
  });
});

describe("Discord reservation-created notification payload", () => {
  it("contains only period metadata and a reservation reference", () => {
    const input = {
      date: "2026-06-17",
      reservationId: "reservation-reference",
      studyPeriod: "FIRST"
    } as const;

    const payload = buildReservationCreatedDiscordPayload(input);

    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0]?.fields).toEqual([
      { inline: false, name: "예약 ID", value: input.reservationId }
    ]);
  });
});

describe("Discord webhook execution URL", () => {
  it("rejects non-Discord webhook hosts", () => {
    expect(() => buildDiscordWebhookExecuteUrl("https://example.test/api/webhooks/1/token")).toThrow(
      "Invalid Discord webhook URL"
    );
  });

  it("rejects non-HTTPS Discord webhook URLs", () => {
    expect(() => buildDiscordWebhookExecuteUrl("http://discord.com/api/webhooks/1/token")).toThrow(
      "Invalid Discord webhook URL"
    );
  });

  it("rejects Discord URLs outside the webhook execution path", () => {
    expect(() => buildDiscordWebhookExecuteUrl("https://discord.com/api/channels/1/token")).toThrow(
      "Invalid Discord webhook URL"
    );
  });

  it("rejects Discord webhook URLs with extra path segments", () => {
    expect(() => buildDiscordWebhookExecuteUrl("https://discord.com/api/webhooks/1/token/extra")).toThrow(
      "Invalid Discord webhook URL"
    );
  });

  it("adds wait=true while preserving existing query params", () => {
    expect(buildDiscordWebhookExecuteUrl("https://discord.com/api/webhooks/1/token?thread_id=abc")).toBe(
      "https://discord.com/api/webhooks/1/token?thread_id=abc&wait=true"
    );
  });
});
