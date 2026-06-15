import { describe, expect, it } from "vitest";

import {
  buildClosedPeriodDiscordPayload,
  buildDiscordWebhookExecuteUrl,
  type ClosedPeriodNotificationInput
} from "./discord-notifications";

const baseInput = {
  applicants: [
    { name: "김도윤", studentNumber: "26001" },
    { name: "박서연", studentNumber: "26002" }
  ],
  capacity: 10,
  closeTime: "16:20",
  confirmedCount: 2,
  date: "2026-06-12",
  studyPeriod: "EIGHTH"
} satisfies ClosedPeriodNotificationInput;

describe("Discord closed-period notification payload", () => {
  it("builds an eighth-period closed list without mentions", () => {
    const payload = buildClosedPeriodDiscordPayload(baseInput);

    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0]?.title).toBe("8면학 마감 신청자 명단");
    expect(payload.embeds[0]?.description).toContain("2026-06-12");
    expect(payload.embeds[0]?.description).toContain("2/10명");
    expect(payload.embeds[0]?.fields[0]?.value).toContain("김도윤 (26001)");
    expect(payload.embeds[0]?.fields[0]?.value).toContain("박서연 (26002)");
  });

  it("marks an empty closed list explicitly", () => {
    const payload = buildClosedPeriodDiscordPayload({ ...baseInput, applicants: [], confirmedCount: 0 });

    expect(payload.embeds[0]?.fields[0]).toEqual({
      inline: false,
      name: "신청자",
      value: "신청자 없음"
    });
  });

  it("chunks a long applicant list inside Discord embed limits", () => {
    const applicants = Array.from({ length: 80 }, (_, index) => ({
      name: `학생${index.toString().padStart(2, "0")}`,
      studentNumber: `26${index.toString().padStart(3, "0")}`
    }));
    const payload = buildClosedPeriodDiscordPayload({
      ...baseInput,
      applicants,
      confirmedCount: applicants.length
    });

    const fields = payload.embeds[0]?.fields ?? [];
    expect(fields.length).toBeGreaterThan(1);
    expect(fields.every((field) => field.value.length <= 1024)).toBe(true);
    expect(fields[0]?.name).toBe("신청자");
    expect(fields[1]?.name).toBe("신청자 계속");
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
