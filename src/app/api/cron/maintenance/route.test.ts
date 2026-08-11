import { beforeEach, describe, expect, it, vi } from "vitest";

type MaintenanceRouteModule = {
  readonly GET: (request: Request) => Promise<Response>;
};

type RunMaintenanceCleanup = (input: { readonly now: Date; readonly store: unknown }) => Promise<unknown>;
type RunJobInput = {
  readonly operation: () => Promise<{
    readonly backlogCount: number;
    readonly failureCode?: string;
    readonly kind: "failed" | "succeeded";
    readonly value: unknown;
  }>;
};

const routeMocks = vi.hoisted(() => ({
  prismaMaintenanceCleanupStore: { kind: "maintenance-store" },
  runOperationalJob: vi.fn<(input: RunJobInput) => Promise<unknown>>(),
  runMaintenanceCleanup: vi.fn<RunMaintenanceCleanup>(),
  outcomes: [] as Array<Awaited<ReturnType<RunJobInput["operation"]>>>
}));

vi.mock("@/lib/maintenance-service", () => ({
  runMaintenanceCleanup: routeMocks.runMaintenanceCleanup
}));

vi.mock("@/lib/prisma-maintenance-store", () => ({
  prismaMaintenanceCleanupStore: routeMocks.prismaMaintenanceCleanupStore
}));

vi.mock("@/lib/operational-job-runner", () => ({
  runOperationalJob: routeMocks.runOperationalJob
}));

vi.mock("@/lib/prisma-operational-job-store", () => ({
  prismaOperationalJobStore: {}
}));

describe("maintenance cron route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    routeMocks.outcomes.length = 0;
    process.env.CLOSED_PERIOD_CRON_SECRET = "closed-period-secret";
    process.env.MAINTENANCE_CRON_SECRET = "maintenance-secret";
    routeMocks.runOperationalJob.mockImplementation(async (input) => {
      const outcome = await input.operation();
      routeMocks.outcomes.push(outcome);
      return outcome.kind === "failed"
        ? { failureCode: outcome.failureCode ?? "job_failed", kind: "failed", value: outcome.value }
        : { kind: "succeeded", value: outcome.value };
    });
  });

  it("returns expired runtime data cleanup counts", async () => {
    routeMocks.runMaintenanceCleanup.mockResolvedValue({
      csrfTokensDeleted: 0,
      expiredSanctionsRevoked: 0,
      backlogCount: 0,
      rateLimitBucketsDeleted: 0,
      retention: { kind: "disabled", policyVersion: "school-policy-v1" },
      restrictionsReleased: 0,
      sessionsDeleted: 0
    });
    const { GET } = await loadMaintenanceRoute();

    const response = await GET(
      new Request("https://example.test/api/cron/maintenance", {
        headers: { authorization: "Bearer maintenance-secret" }
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cleanup: {
        backlogCount: 0,
        csrfTokensDeleted: 0,
        expiredSanctionsRevoked: 0,
        rateLimitBucketsDeleted: 0,
        retention: { kind: "disabled", policyVersion: "school-policy-v1" },
        restrictionsReleased: 0,
        sessionsDeleted: 0
      }
    });
    expect(routeMocks.runMaintenanceCleanup).toHaveBeenCalledWith({
      now: expect.any(Date),
      store: routeMocks.prismaMaintenanceCleanupStore
    });
    expect(routeMocks.outcomes).toEqual([
      expect.objectContaining({ backlogCount: 0, kind: "succeeded" })
    ]);
  });

  it("returns HTTP 500 and a failed job when the bounded cleanup leaves backlog", async () => {
    routeMocks.runMaintenanceCleanup.mockResolvedValue({
      backlogCount: 1,
      csrfTokensDeleted: 0,
      expiredSanctionsRevoked: 0,
      rateLimitBucketsDeleted: 0,
      retention: { kind: "disabled", policyVersion: "school-policy-v1" },
      restrictionsReleased: 0,
      sessionsDeleted: 1_000
    });
    const { GET } = await loadMaintenanceRoute();

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(500);
    expect(routeMocks.outcomes).toEqual([
      expect.objectContaining({
        backlogCount: 1,
        failureCode: "maintenance_backlog_remaining",
        kind: "failed"
      })
    ]);
  });

  it("preserves unexpected_error precedence when cleanup throws after detecting backlog", async () => {
    const cleanupFailure = new Error("retention failed after backlog");
    let observedRejection: unknown;
    routeMocks.runMaintenanceCleanup.mockRejectedValue(cleanupFailure);
    routeMocks.runOperationalJob.mockImplementation(async (input) => {
      try {
        const outcome = await input.operation();
        return { kind: "succeeded", value: outcome.value };
      } catch (error) {
        observedRejection = error;
        if (error !== cleanupFailure) {
          throw error;
        }
        return { failureCode: "unexpected_error", kind: "failed" };
      }
    });
    const { GET } = await loadMaintenanceRoute();

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(500);
    expect(observedRejection).toBe(cleanupFailure);
    expect(routeMocks.runOperationalJob).toHaveBeenCalledOnce();
  });

  it("rejects the closed-period scoped secret", async () => {
    const { GET } = await loadMaintenanceRoute();

    const response = await GET(
      new Request("https://example.test/api/cron/maintenance", {
        headers: { authorization: "Bearer closed-period-secret" }
      })
    );

    expect(response.status).toBe(401);
    expect(routeMocks.runMaintenanceCleanup).not.toHaveBeenCalled();
  });
});

function authorizedRequest(): Request {
  return new Request("https://example.test/api/cron/maintenance", {
    headers: { authorization: "Bearer maintenance-secret" }
  });
}

async function loadMaintenanceRoute(): Promise<MaintenanceRouteModule> {
  const routeModule: unknown = await import("./route");
  if (!isMaintenanceRouteModule(routeModule)) {
    throw new Error("Maintenance route module must export GET.");
  }
  return routeModule;
}

function isMaintenanceRouteModule(value: unknown): value is MaintenanceRouteModule {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "GET") === "function";
}
