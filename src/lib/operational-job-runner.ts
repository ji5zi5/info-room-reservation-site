import { OPERATIONAL_JOB_POLICIES, type OperationalJobName, type OperationalJobStatus } from "./operational-jobs";

export type OperationalJobRecord = {
  readonly backlogCount: number;
  readonly consecutiveFailures: number;
  readonly durationMs: number | null;
  readonly failureCode: string | null;
  readonly finishedAt: Date | null;
  readonly job: OperationalJobName;
  readonly lastAttemptAt: Date;
  readonly lastSuccessAt: Date | null;
  readonly oldestBacklogAt: Date | null;
  readonly result: string | null;
  readonly startedAt: Date;
  readonly status: OperationalJobStatus;
};

export interface OperationalJobStore {
  finish(input: {
    readonly backlogCount: number;
    readonly durationMs: number;
    readonly failureCode: string | null;
    readonly finishedAt: Date;
    readonly job: OperationalJobName;
    readonly oldestBacklogAt: Date | null;
    readonly result: string;
    readonly startedAt: Date;
    readonly succeeded: boolean;
  }): Promise<OperationalJobRecord>;
  tryStart(input: {
    readonly job: OperationalJobName;
    readonly startedAt: Date;
    readonly timeoutMs: number;
  }): Promise<OperationalJobRecord | null>;
}

type OperationalJobOperationResult<T> = {
  readonly backlogCount: number;
  readonly failureCode?: string;
  readonly kind: "failed" | "succeeded";
  readonly oldestBacklogAt: Date | null;
  readonly result: Readonly<Record<string, unknown>>;
  readonly value: T;
};

export type OperationalJobRunResult<T> =
  | { readonly kind: "already_running" }
  | { readonly failureCode: string; readonly kind: "failed"; readonly value?: T }
  | { readonly kind: "succeeded"; readonly value: T };

export async function runOperationalJob<T>(input: {
  readonly clock?: () => Date;
  readonly job: OperationalJobName;
  readonly now: Date;
  readonly operation: () => Promise<OperationalJobOperationResult<T>>;
  readonly store: OperationalJobStore;
}): Promise<OperationalJobRunResult<T>> {
  const claim = await input.store.tryStart({
    job: input.job,
    startedAt: input.now,
    timeoutMs: OPERATIONAL_JOB_POLICIES[input.job].timeoutMs
  });
  if (!claim) {
    return { kind: "already_running" };
  }

  try {
    const outcome = await input.operation();
    const finishedAt = input.clock?.() ?? new Date();
    await input.store.finish({
      backlogCount: outcome.backlogCount,
      durationMs: Math.max(0, finishedAt.getTime() - input.now.getTime()),
      failureCode: outcome.kind === "failed" ? outcome.failureCode ?? "job_failed" : null,
      finishedAt,
      job: input.job,
      oldestBacklogAt: outcome.oldestBacklogAt,
      result: JSON.stringify(outcome.result),
      startedAt: input.now,
      succeeded: outcome.kind === "succeeded"
    });
    return outcome.kind === "succeeded"
      ? { kind: "succeeded", value: outcome.value }
      : { failureCode: outcome.failureCode ?? "job_failed", kind: "failed", value: outcome.value };
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: safeErrorCode(error),
      errorType: error instanceof Error ? error.name : "UnknownError",
      event: "operational_job_unexpected_failure",
      job: input.job
    }));
    const finishedAt = input.clock?.() ?? new Date();
    await input.store.finish({
      backlogCount: 0,
      durationMs: Math.max(0, finishedAt.getTime() - input.now.getTime()),
      failureCode: "unexpected_error",
      finishedAt,
      job: input.job,
      oldestBacklogAt: null,
      result: JSON.stringify({ status: "unexpected_error" }),
      startedAt: input.now,
      succeeded: false
    });
    return { failureCode: "unexpected_error", kind: "failed" };
  }
}

function safeErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") {
    return "unknown";
  }
  return /^[A-Za-z0-9_.:-]{1,64}$/u.test(error.code) ? error.code : "redacted_error";
}
