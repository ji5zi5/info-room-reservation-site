import {
  OPERATIONAL_JOB_POLICIES,
  evaluateOperationalJobReadiness,
  type OperationalJobName,
  type OperationalJobReadiness,
  type OperationalJobState
} from "./operational-jobs";

type SimpleReadinessCheck = {
  readonly code: "invalid" | "not_checked" | "ok" | "unavailable";
  readonly status: "ok" | "unready";
};

export type ReadinessSnapshot = {
  readonly closedPeriodNotificationsEnabled: boolean;
  readonly discordOperationsEnabled?: boolean;
  readonly jobs: readonly (OperationalJobState & { readonly job: OperationalJobName })[];
};

export type ReadinessReport = {
  readonly checks: {
    readonly config: SimpleReadinessCheck;
    readonly database: SimpleReadinessCheck;
    readonly jobs: Record<OperationalJobName, OperationalJobReadiness>;
  };
  readonly status: "degraded" | "ok" | "unready";
};

const NOT_CHECKED_JOB = { code: "never_run", status: "unready" } as const;

export async function getReadinessReport(input: {
  readonly assertConfig: () => void;
  readonly loadSnapshot: () => Promise<ReadinessSnapshot>;
  readonly now: Date;
}): Promise<ReadinessReport> {
  try {
    input.assertConfig();
  } catch {
    return unavailableReport({ code: "invalid", status: "unready" }, { code: "not_checked", status: "unready" });
  }

  let snapshot: ReadinessSnapshot;
  try {
    snapshot = await input.loadSnapshot();
  } catch {
    return unavailableReport({ code: "ok", status: "ok" }, { code: "unavailable", status: "unready" });
  }

  const byJob = new Map(snapshot.jobs.map((job) => [job.job, job]));
  const jobs = {
    CLOSED_PERIOD_NOTIFICATIONS: evaluateOperationalJobReadiness({
      enabled: snapshot.closedPeriodNotificationsEnabled,
      now: input.now,
      policy: OPERATIONAL_JOB_POLICIES.CLOSED_PERIOD_NOTIFICATIONS,
      state: byJob.get("CLOSED_PERIOD_NOTIFICATIONS") ?? null
    }),
    DISCORD_INTERACTIONS: evaluateOperationalJobReadiness({
      enabled: snapshot.discordOperationsEnabled ?? false,
      now: input.now,
      policy: OPERATIONAL_JOB_POLICIES.DISCORD_INTERACTIONS,
      state: byJob.get("DISCORD_INTERACTIONS") ?? null
    }),
    DISCORD_RESERVATION_OUTBOX: evaluateOperationalJobReadiness({
      enabled: snapshot.discordOperationsEnabled ?? false,
      now: input.now,
      policy: OPERATIONAL_JOB_POLICIES.DISCORD_RESERVATION_OUTBOX,
      state: byJob.get("DISCORD_RESERVATION_OUTBOX") ?? null
    }),
    MAINTENANCE: evaluateOperationalJobReadiness({
      enabled: true,
      now: input.now,
      policy: OPERATIONAL_JOB_POLICIES.MAINTENANCE,
      state: byJob.get("MAINTENANCE") ?? null
    })
  } satisfies Record<OperationalJobName, OperationalJobReadiness>;
  const statuses = Object.values(jobs).map((check) => check.status);
  return {
    checks: {
      config: { code: "ok", status: "ok" },
      database: { code: "ok", status: "ok" },
      jobs
    },
    status: statuses.includes("unready") ? "unready" : statuses.includes("degraded") ? "degraded" : "ok"
  };
}

function unavailableReport(config: SimpleReadinessCheck, database: SimpleReadinessCheck): ReadinessReport {
  return {
    checks: {
      config,
      database,
      jobs: {
        CLOSED_PERIOD_NOTIFICATIONS: NOT_CHECKED_JOB,
        DISCORD_INTERACTIONS: NOT_CHECKED_JOB,
        DISCORD_RESERVATION_OUTBOX: NOT_CHECKED_JOB,
        MAINTENANCE: NOT_CHECKED_JOB
      }
    },
    status: "unready"
  };
}
