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
        discord: {
          interactions: { enabled: true, retentionBacklogCount: 0 },
          reservationOutbox: { enabled: true, retentionBacklogCount: 0 }
        },
        jobs: [
          succeededJob("DISCORD_INTERACTIONS"),
          succeededJob("DISCORD_RESERVATION_OUTBOX"),
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
    expect(report.checks.jobs.DISCORD_INTERACTIONS).toEqual({
      backlog: { count: 0, status: "ok" },
      code: "healthy",
      enabled: true,
      freshness: { code: "healthy", status: "ok" },
      retention: { blocked: false, count: 0, status: "ok" },
      status: "ok"
    });
    expect(report.checks.jobs.DISCORD_RESERVATION_OUTBOX).toEqual(expect.objectContaining({
      enabled: true,
      status: "ok"
    }));
    expect(report.checks.jobs.MAINTENANCE).toEqual({ code: "healthy", status: "ok" });
  });

  it("degrades only the retention-blocked Discord sibling while preserving both job reports", async () => {
    const report = await getReadinessReport({
      assertConfig: () => undefined,
      loadSnapshot: async () => ({
        closedPeriodNotificationsEnabled: false,
        discord: {
          interactions: { enabled: true, retentionBacklogCount: 2 },
          reservationOutbox: { enabled: true, retentionBacklogCount: 0 }
        },
        jobs: [
          { ...succeededJob("DISCORD_INTERACTIONS"), backlogCount: 0 },
          { ...succeededJob("DISCORD_RESERVATION_OUTBOX"), backlogCount: 0 },
          { ...succeededJob("DISCORD_RESERVATION_OUTBOX"), job: "MAINTENANCE" as const }
        ]
      }),
      now
    });

    expect(report.status).toBe("degraded");
    expect(report.checks.jobs.DISCORD_INTERACTIONS).toMatchObject({
      retention: { blocked: true, count: 2, status: "degraded" },
      status: "degraded"
    });
    expect(report.checks.jobs.DISCORD_RESERVATION_OUTBOX).toMatchObject({
      retention: { blocked: false, count: 0, status: "ok" },
      status: "ok"
    });
  });

  it.each([
    [null, "never_run", "unready"],
    [{ ...succeededJob("DISCORD_INTERACTIONS"), lastSuccessAt: new Date("2026-06-12T07:21:00.000Z") }, "stale", "unready"],
    [{ ...succeededJob("DISCORD_INTERACTIONS"), consecutiveFailures: 1, status: "FAILED" as const }, "last_attempt_failed", "degraded"]
  ] as const)("reports Discord freshness as %s", async (job, code, status) => {
    const report = await getReadinessReport({
      assertConfig: () => undefined,
      loadSnapshot: async () => ({
        closedPeriodNotificationsEnabled: false,
        discord: {
          interactions: { enabled: true, retentionBacklogCount: 0 },
          reservationOutbox: { enabled: false, retentionBacklogCount: 0 }
        },
        jobs: job === null ? [] : [job]
      }),
      now
    });

    expect(report.checks.jobs.DISCORD_INTERACTIONS).toMatchObject({
      freshness: { code, status },
      status
    });
    expect(report.checks.jobs.DISCORD_RESERVATION_OUTBOX).toMatchObject({ enabled: false });
  });
});

function succeededJob(job: "DISCORD_INTERACTIONS" | "DISCORD_RESERVATION_OUTBOX") {
  return {
    consecutiveFailures: 0,
    finishedAt: new Date("2026-06-12T07:24:00.000Z"),
    job,
    lastAttemptAt: new Date("2026-06-12T07:24:00.000Z"),
    lastSuccessAt: new Date("2026-06-12T07:24:00.000Z"),
    startedAt: new Date("2026-06-12T07:23:00.000Z"),
    status: "SUCCEEDED" as const
  };
}
