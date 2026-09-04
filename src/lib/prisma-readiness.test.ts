import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertProductionEnvSafe: vi.fn(),
  getDiscordReadinessState: vi.fn(),
  getNotificationSettings: vi.fn(),
  getOperationalJobs: vi.fn(),
  parseDiscordApplicationConfig: vi.fn(),
  queryRaw: vi.fn()
}));

vi.mock("./db", () => ({ prisma: { $queryRaw: mocks.queryRaw } }));
vi.mock("./env", () => ({ assertProductionEnvSafe: mocks.assertProductionEnvSafe }));
vi.mock("./discord-app-config", () => ({
  parseDiscordApplicationConfig: mocks.parseDiscordApplicationConfig
}));
vi.mock("./prisma-notification-settings", () => ({
  getPrismaNotificationSettings: mocks.getNotificationSettings
}));
vi.mock("./prisma-operational-job-store", () => ({
  getPrismaOperationalJobs: mocks.getOperationalJobs
}));
vi.mock("./prisma-discord-reservation-maintenance-repository", () => ({
  getPrismaDiscordReadinessState: mocks.getDiscordReadinessState
}));

import { getPrismaReadinessReport } from "./prisma-readiness";

describe("Prisma readiness report", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.queryRaw.mockResolvedValue([{ ok: 1 }]);
    mocks.getNotificationSettings.mockResolvedValue({
      closedPeriodNotificationsEnabled: false,
      reservationCreatedNotificationsEnabled: false
    });
    mocks.getDiscordReadinessState.mockResolvedValue({
      interactionsEnabled: false,
      interactionsRetentionBacklogCount: 0,
      reservationOutboxRetentionBacklogCount: 0
    });
    mocks.getOperationalJobs.mockResolvedValue([
      succeededJob("DISCORD_ADMIN_CONSOLE"),
      succeededJob("MAINTENANCE")
    ]);
  });

  it("monitors the Discord admin console when application credentials are configured", async () => {
    // Given: the bot application is configured and its admin-console worker has run successfully.
    mocks.parseDiscordApplicationConfig.mockReturnValue({ applicationId: "configured" });

    // When: production readiness is evaluated.
    const report = await getPrismaReadinessReport(new Date("2026-09-04T10:06:30.000Z"));

    // Then: the active operations board is monitored instead of being reported as disabled.
    expect(report.checks.jobs.DISCORD_ADMIN_CONSOLE).toEqual({ code: "healthy", status: "ok" });
    expect(mocks.parseDiscordApplicationConfig).toHaveBeenCalledWith(process.env);
  });
});

function succeededJob(job: "DISCORD_ADMIN_CONSOLE" | "MAINTENANCE") {
  const timestamp = new Date("2026-09-04T10:06:00.000Z");
  return {
    backlogCount: 0,
    consecutiveFailures: 0,
    finishedAt: timestamp,
    job,
    lastAttemptAt: timestamp,
    lastSuccessAt: timestamp,
    startedAt: timestamp,
    status: "SUCCEEDED" as const
  };
}
