import { beforeEach, describe, expect, it, vi } from "vitest";

type MaintenanceRouteModule = {
  readonly GET: (request: Request) => Promise<Response>;
};

type RunMaintenanceCleanup = (input: { readonly now: Date; readonly store: unknown }) => Promise<unknown>;
type RunJobInput = {
  readonly operation: () => Promise<{ readonly kind: "succeeded"; readonly value: unknown }>;
};

const routeMocks = vi.hoisted(() => ({
  prismaMaintenanceCleanupStore: { kind: "maintenance-store" },
  runOperationalJob: vi.fn<(input: RunJobInput) => Promise<unknown>>(),
  runMaintenanceCleanup: vi.fn<RunMaintenanceCleanup>()
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
    process.env.CLOSED_PERIOD_CRON_SECRET = "closed-period-secret";
    process.env.MAINTENANCE_CRON_SECRET = "maintenance-secret";
    routeMocks.runOperationalJob.mockImplementation(async (input) => {
      const outcome = await input.operation();
      return { kind: "succeeded", value: outcome.value };
    });
  });

  it("returns expired runtime data cleanup counts", async () => {
    routeMocks.runMaintenanceCleanup.mockResolvedValue({
      csrfTokensDeleted: 0,
      expiredSanctionsRevoked: 0,
      rateLimitBucketsDeleted: 0,
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
        csrfTokensDeleted: 0,
        expiredSanctionsRevoked: 0,
        rateLimitBucketsDeleted: 0,
        restrictionsReleased: 0,
        sessionsDeleted: 0
      }
    });
    expect(routeMocks.runMaintenanceCleanup).toHaveBeenCalledWith({
      now: expect.any(Date),
      store: routeMocks.prismaMaintenanceCleanupStore
    });
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
