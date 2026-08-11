import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultNotificationSettings } from "@/lib/notification-settings";

type JobOutcome = {
  readonly failureCode?: string;
  readonly kind: "failed" | "succeeded";
  readonly value: unknown;
};

type RunJobInput = { readonly operation: () => Promise<JobOutcome> };

const routeMocks = vi.hoisted(() => ({
  createClosedPeriodNotificationService: vi.fn(),
  getClosedPeriodNotificationBacklogSummary: vi.fn(),
  getDueClosedPeriodNotificationCandidates: vi.fn(),
  getMockNotificationSettings: vi.fn(),
  getPrismaNotificationSettings: vi.fn(),
  isNoDatabaseMockMode: vi.fn<() => boolean>(),
  runDiscordReservationOutbox: vi.fn(),
  runOperationalJob: vi.fn<(input: RunJobInput) => Promise<unknown>>(),
  sendClosedPeriod: vi.fn(),
  sendDiscordWebhook: vi.fn()
}));

vi.mock("@/lib/closed-period-notification-service", () => ({
  createClosedPeriodNotificationService: routeMocks.createClosedPeriodNotificationService
}));

vi.mock("@/lib/discord-reservation-outbox", () => ({
  runDiscordReservationOutbox: routeMocks.runDiscordReservationOutbox
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
  getClosedPeriodNotificationBacklogSummary: routeMocks.getClosedPeriodNotificationBacklogSummary,
  getDueClosedPeriodNotificationCandidates: routeMocks.getDueClosedPeriodNotificationCandidates,
  prismaClosedPeriodNotificationRepository: {}
}));

vi.mock("@/lib/operational-job-runner", () => ({
  runOperationalJob: routeMocks.runOperationalJob
}));

vi.mock("@/lib/prisma-operational-job-store", () => ({
  prismaOperationalJobStore: {}
}));

vi.mock("@/lib/discord-notifications", () => ({
  sendDiscordWebhook: routeMocks.sendDiscordWebhook
}));

import { GET } from "./route";

describe("closed-period notification cron", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("CLOSED_PERIOD_CRON_SECRET", "closed-period-secret");
    vi.stubEnv("MAINTENANCE_CRON_SECRET", "maintenance-secret");
    vi.stubEnv("DISCORD_WEBHOOK_URL", "");
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.getPrismaNotificationSettings.mockResolvedValue(defaultNotificationSettings());
    routeMocks.getMockNotificationSettings.mockReturnValue(defaultNotificationSettings());
    routeMocks.getDueClosedPeriodNotificationCandidates.mockResolvedValue([]);
    routeMocks.getClosedPeriodNotificationBacklogSummary.mockResolvedValue({ count: 0, oldestAt: null });
    routeMocks.runDiscordReservationOutbox.mockResolvedValue({
      initial: { claimed: 0, retried: 0, sent: 0, terminal: 0 },
      kind: "processed",
      sync: { abandoned: 0, claimed: 0, retried: 0, synced: 0 }
    });
    routeMocks.runOperationalJob.mockImplementation(async (input) => {
      const outcome = await input.operation();
      return outcome.kind === "succeeded"
        ? { kind: "succeeded", value: outcome.value }
        : { failureCode: outcome.failureCode ?? "job_failed", kind: "failed", value: outcome.value };
    });
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
      reservationOutbox: expect.objectContaining({ kind: "processed" }),
      results: [],
      skipped: "closed_period_notifications_disabled"
    });
    expect(routeMocks.runDiscordReservationOutbox).toHaveBeenCalledWith({ now: expect.any(Date) });
    expect(routeMocks.getDueClosedPeriodNotificationCandidates).not.toHaveBeenCalled();
  });

  it("still reports a missing webhook when automatic closed-list notifications are enabled", async () => {
    const response = await GET(cronRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "discord_webhook_missing",
        message: "Discord webhook 설정이 필요합니다."
      },
      reservationOutbox: expect.objectContaining({ kind: "processed" })
    });
  });

  it("accepts only the closed-period scoped secret", async () => {
    const response = await GET(
      new Request("https://example.test/api/cron/closed-period-notifications", {
        headers: { authorization: "Bearer maintenance-secret" }
      })
    );

    expect(response.status).toBe(401);
  });

  it("returns a failing status when a Discord result is unknown", async () => {
    vi.stubEnv("DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/1/token");
    routeMocks.getDueClosedPeriodNotificationCandidates.mockResolvedValue([
      { date: "2026-06-12", studyPeriod: "EIGHTH" }
    ]);
    routeMocks.getClosedPeriodNotificationBacklogSummary.mockResolvedValue({
      count: 1,
      oldestAt: new Date("2026-06-12T07:25:00.000Z")
    });
    routeMocks.sendClosedPeriod.mockResolvedValue({ kind: "unknown" });

    const response = await GET(cronRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      backlog: { count: 1, oldestAt: "2026-06-12T07:25:00.000Z" },
      failed: 0,
      processed: 1,
      reservationOutbox: expect.objectContaining({ kind: "processed" }),
      sent: 0,
      skipped: 0,
      unknown: 1
    });
  });

  it("runs reservation recovery safely in no-database mock mode before the disabled return", async () => {
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);
    routeMocks.getMockNotificationSettings.mockReturnValue({
      ...defaultNotificationSettings(),
      closedPeriodNotificationsEnabled: false
    });
    routeMocks.runDiscordReservationOutbox.mockResolvedValue({ kind: "skipped", reason: "no_database_mock" });

    const response = await GET(cronRequest());

    expect(response.status).toBe(200);
    expect(routeMocks.runDiscordReservationOutbox).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      reservationOutbox: { kind: "skipped", reason: "no_database_mock" }
    });
    expect(routeMocks.getPrismaNotificationSettings).not.toHaveBeenCalled();
  });
});

function cronRequest(): Request {
  return new Request("https://example.test/api/cron/closed-period-notifications", {
    headers: { authorization: "Bearer closed-period-secret" }
  });
}
