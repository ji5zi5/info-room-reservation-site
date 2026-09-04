export const OPERATIONAL_JOB_NAMES = [
  "CLOSED_PERIOD_NOTIFICATIONS",
  "DISCORD_ADMIN_CONSOLE",
  "DISCORD_INTERACTIONS",
  "DISCORD_RESERVATION_OUTBOX",
  "MAINTENANCE"
] as const;

export type OperationalJobName = (typeof OPERATIONAL_JOB_NAMES)[number];

export const OPERATIONAL_JOB_POLICIES = {
  CLOSED_PERIOD_NOTIFICATIONS: {
    intervalMs: 60_000,
    timeoutMs: 2 * 60_000
  },
  DISCORD_ADMIN_CONSOLE: {
    intervalMs: 60_000,
    timeoutMs: 2 * 60_000
  },
  DISCORD_INTERACTIONS: {
    intervalMs: 60_000,
    timeoutMs: 2 * 60_000
  },
  DISCORD_RESERVATION_OUTBOX: {
    intervalMs: 60_000,
    timeoutMs: 2 * 60_000
  },
  MAINTENANCE: {
    intervalMs: 24 * 60 * 60_000,
    timeoutMs: 15 * 60_000
  }
} as const satisfies Record<OperationalJobName, { readonly intervalMs: number; readonly timeoutMs: number }>;

export function isOperationalJobName(value: string): value is OperationalJobName {
  return OPERATIONAL_JOB_NAMES.some((job) => job === value);
}
export type OperationalJobStatus = "FAILED" | "RUNNING" | "SUCCEEDED";

export type OperationalJobState = {
  readonly backlogCount?: number;
  readonly consecutiveFailures: number;
  readonly finishedAt: Date | null;
  readonly lastAttemptAt: Date;
  readonly lastSuccessAt: Date | null;
  readonly startedAt: Date;
  readonly status: OperationalJobStatus;
};

export type OperationalJobReadiness = {
  readonly code:
    | "backlog"
    | "disabled"
    | "healthy"
    | "last_attempt_failed"
    | "never_run"
    | "never_succeeded"
    | "repeated_failures"
    | "running"
    | "running_timeout"
    | "stale";
  readonly status: "degraded" | "ok" | "unready";
};

export function evaluateOperationalJobReadiness(input: {
  readonly enabled: boolean;
  readonly now: Date;
  readonly policy: { readonly intervalMs: number; readonly timeoutMs: number };
  readonly state: OperationalJobState | null;
}): OperationalJobReadiness {
  if (!input.enabled) {
    return { code: "disabled", status: "ok" };
  }
  if (!input.state) {
    return { code: "never_run", status: "unready" };
  }
  if (input.state.status === "RUNNING") {
    return input.now.getTime() - input.state.startedAt.getTime() > input.policy.timeoutMs
      ? { code: "running_timeout", status: "unready" }
      : { code: "running", status: "degraded" };
  }
  if (input.state.consecutiveFailures >= 2) {
    return { code: "repeated_failures", status: "unready" };
  }
  if (!input.state.lastSuccessAt) {
    return { code: "never_succeeded", status: "unready" };
  }
  if (input.now.getTime() - input.state.lastSuccessAt.getTime() > input.policy.intervalMs * 3) {
    return { code: "stale", status: "unready" };
  }
  if (input.state.status === "FAILED") {
    return { code: "last_attempt_failed", status: "degraded" };
  }
  if ((input.state.backlogCount ?? 0) > 0) {
    return { code: "backlog", status: "degraded" };
  }
  return { code: "healthy", status: "ok" };
}
