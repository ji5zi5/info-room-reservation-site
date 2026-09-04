import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultNotificationSettings } from "@/lib/notification-settings";

type JobOutcome = {
  readonly failureCode?: string;
  readonly kind: "failed" | "succeeded";
  readonly value: unknown;
};
type RunJobInput = {
  readonly job: string;
  readonly operation: () => Promise<JobOutcome>;
};

const routeMocks = vi.hoisted(() => ({
  activateApplicationContract: vi.fn(),
  createClosedPeriodNotificationService: vi.fn(),
  getClosedPeriodNotificationBacklogSummary: vi.fn(),
  getDueClosedPeriodNotificationCandidates: vi.fn(),
  getMockNotificationSettings: vi.fn(),
  getPrismaNotificationSettings: vi.fn(),
  isNoDatabaseMockMode: vi.fn<() => boolean>(),
  outcomes: new Map<string, "failed" | "rejected" | "running" | "succeeded">(),
  runDiscordAdminCommandCronWorker: vi.fn(),
  runDiscordInteractionCronWorker: vi.fn(),
  runDiscordReservationOutbox: vi.fn(),
  runOperationalJob: vi.fn<(input: RunJobInput) => Promise<unknown>>(),
  sendClosedPeriod: vi.fn(),
  sendDiscordWebhook: vi.fn()
}));

vi.mock("@/lib/application-contract-activation", () => ({
  activateApplicationContract: routeMocks.activateApplicationContract
}));

vi.mock("@/lib/closed-period-notification-service", () => ({
  createClosedPeriodNotificationService: routeMocks.createClosedPeriodNotificationService
}));
vi.mock("@/lib/discord-reservation-outbox", () => ({
  runDiscordInteractionCronWorker: routeMocks.runDiscordInteractionCronWorker,
  runDiscordReservationOutbox: routeMocks.runDiscordReservationOutbox
}));
vi.mock("@/lib/discord-admin-interaction-completion", () => ({
  runDiscordAdminCommandCronWorker: routeMocks.runDiscordAdminCommandCronWorker
}));
vi.mock("@/lib/mock-dev-mode", () => ({ isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode }));
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
vi.mock("@/lib/operational-job-runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operational-job-runner")>()),
  runOperationalJob: routeMocks.runOperationalJob
}));
vi.mock("@/lib/prisma-operational-job-store", () => ({ prismaOperationalJobStore: {} }));
vi.mock("@/lib/discord-notifications", () => ({ sendDiscordWebhook: routeMocks.sendDiscordWebhook }));

import { GET } from "./route";

describe("closed-period notification cron", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    routeMocks.outcomes.clear();
    vi.stubEnv("CLOSED_PERIOD_CRON_SECRET", "closed-period-secret");
    vi.stubEnv("MAINTENANCE_CRON_SECRET", "maintenance-secret");
    vi.stubEnv("DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/1/token");
    vi.stubEnv("DISCORD_APPLICATION_ID", "10000000000000001");
    vi.stubEnv("DISCORD_PUBLIC_KEY", "a".repeat(64));
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_GUILD_ID", "10000000000000002");
    vi.stubEnv("DISCORD_CHANNEL_ID", "10000000000000003");
    vi.stubEnv("DISCORD_ADMIN_ROLE_ID", "10000000000000004");
    vi.stubEnv("DISCORD_ADMIN_USER_MAP", "10000000000000005:12345");
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.activateApplicationContract.mockResolvedValue({
      deploymentSha: "a".repeat(40),
      kind: "already_active",
      source: "FIRST_CRON"
    });
    routeMocks.getPrismaNotificationSettings.mockResolvedValue(defaultNotificationSettings());
    routeMocks.getMockNotificationSettings.mockReturnValue(defaultNotificationSettings());
    routeMocks.getDueClosedPeriodNotificationCandidates.mockResolvedValue([]);
    routeMocks.getClosedPeriodNotificationBacklogSummary.mockResolvedValue({ count: 0, oldestAt: null });
    routeMocks.runDiscordInteractionCronWorker.mockResolvedValue({
      abandoned: 0,
      backlog: { count: 0, oldestAt: null },
      claimed: 0,
      retried: 0,
      stale: 0,
      succeeded: 0
    });
    routeMocks.runDiscordAdminCommandCronWorker.mockResolvedValue({
      board: { kind: "unchanged" },
      commands: { abandoned: 0, claimed: 0, retried: 0, stale: 0, succeeded: 0 },
      deliveries: { delivered: 0, failed: 0 }
    });
    routeMocks.runDiscordReservationOutbox.mockResolvedValue({
      initial: { claimed: 0, retried: 0, review: 0, sent: 0, terminal: 0 },
      kind: "processed",
      sync: { abandoned: 0, claimed: 0, retried: 0, synced: 0 }
    });
    routeMocks.runOperationalJob.mockImplementation(async (input) => {
      const configured = routeMocks.outcomes.get(input.job);
      if (configured === "running") return { kind: "already_running" };
      if (configured === "failed") return { failureCode: `${input.job.toLowerCase()}_failed`, kind: "failed" };
      if (configured === "rejected") throw new Error(`${input.job} runner unavailable`);
      try {
        const outcome = await input.operation();
        return outcome.kind === "succeeded"
          ? { kind: "succeeded", value: outcome.value }
          : { failureCode: outcome.failureCode ?? "job_failed", kind: "failed", value: outcome.value };
      } catch {
        return { failureCode: "unexpected_error", kind: "failed" };
      }
    });
    routeMocks.createClosedPeriodNotificationService.mockReturnValue({ sendClosedPeriod: routeMocks.sendClosedPeriod });
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [false, false, false, false],
    [true, false, false, false],
    [false, true, false, false],
    [false, false, true, false],
    [false, false, false, true],
    [true, true, false, false],
    [true, false, true, false],
    [true, false, false, true],
    [false, true, true, false],
    [false, true, false, true],
    [false, false, true, true],
    [true, true, true, false],
    [true, true, false, true],
    [true, false, true, true],
    [false, true, true, true],
    [true, true, true, true]
  ] as const)("settles all siblings when failures are %s/%s/%s/%s", async (admin, interactions, outbox, closed) => {
    if (admin) routeMocks.outcomes.set("DISCORD_ADMIN_CONSOLE", "rejected");
    if (interactions) routeMocks.outcomes.set("DISCORD_INTERACTIONS", "rejected");
    if (outbox) routeMocks.outcomes.set("DISCORD_RESERVATION_OUTBOX", "rejected");
    if (closed) routeMocks.outcomes.set("CLOSED_PERIOD_NOTIFICATIONS", "rejected");

    const response = await GET(cronRequest());
    const body = await response.json();

    expect(routeMocks.runOperationalJob.mock.calls.map(([input]) => input.job)).toEqual([
      "DISCORD_ADMIN_CONSOLE",
      "DISCORD_INTERACTIONS",
      "DISCORD_RESERVATION_OUTBOX",
      "CLOSED_PERIOD_NOTIFICATIONS"
    ]);
    expect(response.status).toBe(admin || interactions || outbox || closed ? 502 : 200);
    expect(body).toEqual({
      activation: admin || interactions || outbox || closed
        ? { kind: "deferred", reason: "sibling_job_failed" }
        : {
            deploymentSha: "a".repeat(40),
            kind: "already_active",
            source: "FIRST_CRON"
          },
      jobs: {
        CLOSED_PERIOD_NOTIFICATIONS: expect.objectContaining({ kind: closed ? "failed" : "succeeded" }),
        DISCORD_ADMIN_CONSOLE: expect.objectContaining({ kind: admin ? "failed" : "succeeded" }),
        DISCORD_INTERACTIONS: expect.objectContaining({ kind: interactions ? "failed" : "succeeded" }),
        DISCORD_RESERVATION_OUTBOX: expect.objectContaining({ kind: outbox ? "failed" : "succeeded" })
      },
      ok: !(admin || interactions || outbox || closed)
    });
    expect(routeMocks.activateApplicationContract).toHaveBeenCalledTimes(admin || interactions || outbox || closed ? 0 : 1);
  });

  it("records disabled closed-list work without skipping Discord workers", async () => {
    routeMocks.getPrismaNotificationSettings.mockResolvedValue({
      ...defaultNotificationSettings(),
      closedPeriodNotificationsEnabled: false
    });

    const response = await GET(cronRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(routeMocks.runDiscordInteractionCronWorker).toHaveBeenCalledOnce();
    expect(routeMocks.runDiscordReservationOutbox).toHaveBeenCalledOnce();
    expect(body.jobs.CLOSED_PERIOD_NOTIFICATIONS).toEqual({
      kind: "succeeded",
      value: { kind: "disabled", processed: 0 }
    });
    expect(routeMocks.getDueClosedPeriodNotificationCandidates).not.toHaveBeenCalled();
  });

  it("fails the cron visibly when the operations board cannot synchronize", async () => {
    // Given: command processing succeeds but the pinned board update fails.
    routeMocks.runDiscordAdminCommandCronWorker.mockResolvedValue({
      board: { code: "discord_http_403", kind: "failed" },
      commands: { abandoned: 0, claimed: 0, retried: 0, stale: 0, succeeded: 0 },
      deliveries: { delivered: 0, failed: 0 }
    });

    // When: the scheduled worker runs.
    const response = await GET(cronRequest());
    const body = await response.json();

    // Then: monitoring receives a failed job instead of a false all-clear response.
    expect(response.status).toBe(502);
    expect(body.jobs.DISCORD_ADMIN_CONSOLE).toMatchObject({
      failureCode: "discord_http_403",
      kind: "failed"
    });
    expect(body.activation).toEqual({ kind: "deferred", reason: "sibling_job_failed" });
  });

  it("records Discord application workers as disabled when only a webhook is configured", async () => {
    for (const key of [
      "DISCORD_APPLICATION_ID",
      "DISCORD_PUBLIC_KEY",
      "DISCORD_BOT_TOKEN",
      "DISCORD_GUILD_ID",
      "DISCORD_CHANNEL_ID",
      "DISCORD_ADMIN_ROLE_ID",
      "DISCORD_ADMIN_USER_MAP"
    ]) {
      vi.stubEnv(key, "");
    }

    const response = await GET(cronRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(routeMocks.runDiscordInteractionCronWorker).not.toHaveBeenCalled();
    expect(routeMocks.runDiscordAdminCommandCronWorker).not.toHaveBeenCalled();
    expect(body.jobs.DISCORD_INTERACTIONS).toEqual({
      kind: "succeeded",
      value: { kind: "disabled" }
    });
    expect(body.jobs.DISCORD_ADMIN_CONSOLE).toEqual({
      kind: "succeeded",
      value: { kind: "disabled" }
    });
  });

  it("settles siblings before reporting a closed-list preflight failure", async () => {
    routeMocks.getPrismaNotificationSettings.mockRejectedValue(new Error("settings unavailable"));

    const response = await GET(cronRequest());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(routeMocks.runDiscordInteractionCronWorker).toHaveBeenCalledOnce();
    expect(routeMocks.runDiscordReservationOutbox).toHaveBeenCalledOnce();
    expect(body.jobs.CLOSED_PERIOD_NOTIFICATIONS).toEqual({ failureCode: "unexpected_error", kind: "failed" });
    expect(body.activation).toEqual({ kind: "deferred", reason: "sibling_job_failed" });
    expect(routeMocks.activateApplicationContract).not.toHaveBeenCalled();
  });

  it("reports already-running work without failing siblings", async () => {
    routeMocks.outcomes.set("DISCORD_INTERACTIONS", "running");

    const response = await GET(cronRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jobs: { DISCORD_INTERACTIONS: { kind: "already_running" } },
      ok: true
    });
  });

  it("accepts only the closed-period scoped secret", async () => {
    const response = await GET(new Request("https://example.test/api/cron/closed-period-notifications", {
      headers: { authorization: "Bearer maintenance-secret" }
    }));

    expect(response.status).toBe(401);
    expect(routeMocks.runOperationalJob).not.toHaveBeenCalled();
  });

  it("invokes FIRST_CRON activation only after all four sibling jobs settle", async () => {
    // Given: one sibling remains pending while the other three settle.
    let finishInteraction: (() => void) | undefined;
    routeMocks.runDiscordInteractionCronWorker.mockImplementation(() => new Promise((resolve) => {
      finishInteraction = () => resolve({
        abandoned: 0, backlog: { count: 0, oldestAt: null }, claimed: 0,
        retried: 0, stale: 0, succeeded: 0
      });
    }));

    // When: the cron starts but its interaction worker has not settled.
    const responsePromise = GET(cronRequest());
    await vi.waitFor(() => expect(routeMocks.runOperationalJob).toHaveBeenCalledTimes(4));

    // Then: activation waits for the final sibling, then uses the shared FIRST_CRON source.
    expect(routeMocks.activateApplicationContract).not.toHaveBeenCalled();
    finishInteraction?.();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(routeMocks.activateApplicationContract).toHaveBeenCalledWith({ source: "FIRST_CRON" });
    await expect(response.json()).resolves.toMatchObject({ activation: { kind: "already_active" } });
  });
});

function cronRequest(): Request {
  return new Request("https://example.test/api/cron/closed-period-notifications", {
    headers: { authorization: "Bearer closed-period-secret" }
  });
}
