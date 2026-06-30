import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultNotificationSettings } from "@/lib/notification-settings";

const routeMocks = vi.hoisted(() => ({
  createClosedPeriodNotificationService: vi.fn(),
  getDueClosedPeriodNotificationCandidates: vi.fn(),
  getMockNotificationSettings: vi.fn(),
  getPrismaNotificationSettings: vi.fn(),
  isNoDatabaseMockMode: vi.fn<() => boolean>(),
  sendClosedPeriod: vi.fn(),
  sendDiscordWebhook: vi.fn()
}));

vi.mock("@/lib/closed-period-notification-service", () => ({
  createClosedPeriodNotificationService: routeMocks.createClosedPeriodNotificationService
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode
}));

vi.mock("@/lib/mock-notification-settings", () => ({
  getMockNotificationSettings: routeMocks.getMockNotificationSettings
}));

vi.mock("@/lib/prisma-notification-settings", () => ({
  getPrismaNotificationSettings: routeMocks.getPrismaNotificationSettings
}));

vi.mock("@/lib/prisma-notification-repository", () => ({
  getDueClosedPeriodNotificationCandidates: routeMocks.getDueClosedPeriodNotificationCandidates,
  prismaClosedPeriodNotificationRepository: {}
}));

vi.mock("@/lib/discord-notifications", () => ({
  sendDiscordWebhook: routeMocks.sendDiscordWebhook
}));

import { GET } from "./route";

describe("closed-period notification cron", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("CRON_SECRET", "cron-secret");
    vi.stubEnv("DISCORD_WEBHOOK_URL", "");
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.getPrismaNotificationSettings.mockResolvedValue(defaultNotificationSettings());
    routeMocks.getMockNotificationSettings.mockReturnValue(defaultNotificationSettings());
    routeMocks.getDueClosedPeriodNotificationCandidates.mockResolvedValue([]);
    routeMocks.createClosedPeriodNotificationService.mockReturnValue({
      sendClosedPeriod: routeMocks.sendClosedPeriod
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips with 200 before requiring a webhook when automatic closed-list notifications are disabled", async () => {
    routeMocks.getPrismaNotificationSettings.mockResolvedValue({
      ...defaultNotificationSettings(),
      closedPeriodNotificationsEnabled: false
    });

    const response = await GET(cronRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      processed: 0,
      results: [],
      skipped: "closed_period_notifications_disabled"
    });
    expect(routeMocks.getDueClosedPeriodNotificationCandidates).not.toHaveBeenCalled();
  });

  it("still reports a missing webhook when automatic closed-list notifications are enabled", async () => {
    const response = await GET(cronRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "discord_webhook_missing",
        message: "Discord webhook 설정이 필요합니다."
      }
    });
  });
});

function cronRequest(): Request {
  return new Request("https://example.test/api/cron/closed-period-notifications", {
    headers: { authorization: "Bearer cron-secret" }
  });
}
