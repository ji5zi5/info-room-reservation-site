import { describe, expect, it, vi } from "vitest";

import { getReadinessReport } from "./readiness";

const now = new Date("2026-06-12T07:25:00.000Z");

describe("readiness report", () => {
  it("reports invalid runtime configuration without querying the database", async () => {
    const loadSnapshot = vi.fn();

    const report = await getReadinessReport({
      assertConfig: () => {
        throw new Error("invalid config");
      },
      loadSnapshot,
      now
    });

    expect(report.status).toBe("unready");
    expect(report.checks.config).toEqual({ code: "invalid", status: "unready" });
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it("reports a read-only database failure as unready", async () => {
    const report = await getReadinessReport({
      assertConfig: () => undefined,
      loadSnapshot: async () => {
        throw new Error("db unavailable");
      },
      now
    });

    expect(report.status).toBe("unready");
    expect(report.checks.database).toEqual({ code: "unavailable", status: "unready" });
  });

  it("excludes disabled notifications and accepts a fresh maintenance success", async () => {
    const report = await getReadinessReport({
      assertConfig: () => undefined,
      loadSnapshot: async () => ({
        closedPeriodNotificationsEnabled: false,
        jobs: [
          {
            consecutiveFailures: 0,
            finishedAt: new Date("2026-06-12T07:24:00.000Z"),
            job: "MAINTENANCE",
            lastAttemptAt: new Date("2026-06-12T07:24:00.000Z"),
            lastSuccessAt: new Date("2026-06-12T07:24:00.000Z"),
            startedAt: new Date("2026-06-12T07:23:00.000Z"),
            status: "SUCCEEDED"
          }
        ]
      }),
      now
    });

    expect(report.status).toBe("ok");
    expect(report.checks.jobs.CLOSED_PERIOD_NOTIFICATIONS).toEqual({ code: "disabled", status: "ok" });
    expect(report.checks.jobs.MAINTENANCE).toEqual({ code: "healthy", status: "ok" });
  });
});
