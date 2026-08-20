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
  readonly discord?: {
    readonly interactions: DiscordReadinessSnapshot;
    readonly reservationOutbox: DiscordReadinessSnapshot;
  };
  readonly discordOperationsEnabled?: boolean;
  readonly jobs: readonly (OperationalJobState & {
    readonly backlogCount?: number;
    readonly job: OperationalJobName;
  })[];
};

type DiscordReadinessSnapshot = {
  readonly enabled: boolean;
  readonly retentionBacklogCount: number;
};

export type DiscordOperationalJobReadiness = {
  readonly backlog: { readonly count: number; readonly status: "degraded" | "ok" };
  readonly code: OperationalJobReadiness["code"];
  readonly enabled: boolean;
  readonly freshness: OperationalJobReadiness;
  readonly retention: {
    readonly blocked: boolean;
    readonly count: number;
    readonly status: "degraded" | "ok";
  };
  readonly status: OperationalJobReadiness["status"];
};

export type ReadinessReport = {
  readonly checks: {
    readonly config: SimpleReadinessCheck;
    readonly database: SimpleReadinessCheck;
    readonly jobs: Record<
      OperationalJobName,
      OperationalJobReadiness | DiscordOperationalJobReadiness
    >;
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
  const fallbackDiscord = {
    enabled: snapshot.discordOperationsEnabled ?? false,
    retentionBacklogCount: 0
  };
  const jobs = {
    CLOSED_PERIOD_NOTIFICATIONS: evaluateOperationalJobReadiness({
      enabled: snapshot.closedPeriodNotificationsEnabled,
      now: input.now,
      policy: OPERATIONAL_JOB_POLICIES.CLOSED_PERIOD_NOTIFICATIONS,
      state: byJob.get("CLOSED_PERIOD_NOTIFICATIONS") ?? null
    }),
    DISCORD_ADMIN_CONSOLE: evaluateOperationalJobReadiness({
      enabled: snapshot.discordOperationsEnabled ?? false,
      now: input.now,
      policy: OPERATIONAL_JOB_POLICIES.DISCORD_ADMIN_CONSOLE,
      state: byJob.get("DISCORD_ADMIN_CONSOLE") ?? null
    }),
    DISCORD_INTERACTIONS: discordJobReadiness({
      job: "DISCORD_INTERACTIONS",
      now: input.now,
      snapshot: snapshot.discord?.interactions ?? fallbackDiscord,
      state: byJob.get("DISCORD_INTERACTIONS") ?? null
    }),
    DISCORD_RESERVATION_OUTBOX: discordJobReadiness({
      job: "DISCORD_RESERVATION_OUTBOX",
      now: input.now,
      snapshot: snapshot.discord?.reservationOutbox ?? fallbackDiscord,
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

function discordJobReadiness(input: {
  readonly job: "DISCORD_INTERACTIONS" | "DISCORD_RESERVATION_OUTBOX";
  readonly now: Date;
  readonly snapshot: DiscordReadinessSnapshot;
  readonly state: (OperationalJobState & { readonly backlogCount?: number }) | null;
}): DiscordOperationalJobReadiness {
  const freshness = evaluateOperationalJobReadiness({
    enabled: input.snapshot.enabled,
    now: input.now,
    policy: OPERATIONAL_JOB_POLICIES[input.job],
    state: input.state
  });
  const backlogCount = input.state?.backlogCount ?? 0;
  const retentionBlocked = input.snapshot.retentionBacklogCount > 0;
  const degraded = backlogCount > 0 || retentionBlocked;
  return {
    backlog: { count: backlogCount, status: backlogCount > 0 ? "degraded" : "ok" },
    code: freshness.code,
    enabled: input.snapshot.enabled,
    freshness,
    retention: {
      blocked: retentionBlocked,
      count: input.snapshot.retentionBacklogCount,
      status: retentionBlocked ? "degraded" : "ok"
    },
    status: freshness.status === "unready"
      ? "unready"
      : freshness.status === "degraded" || degraded ? "degraded" : "ok"
  };
}

function unavailableReport(config: SimpleReadinessCheck, database: SimpleReadinessCheck): ReadinessReport {
  return {
    checks: {
      config,
      database,
      jobs: {
        CLOSED_PERIOD_NOTIFICATIONS: NOT_CHECKED_JOB,
        DISCORD_ADMIN_CONSOLE: NOT_CHECKED_JOB,
        DISCORD_INTERACTIONS: NOT_CHECKED_JOB,
        DISCORD_RESERVATION_OUTBOX: NOT_CHECKED_JOB,
        MAINTENANCE: NOT_CHECKED_JOB
      }
    },
    status: "unready"
  };
}
