import type { OperationalJob, Prisma } from "@prisma/client";

import { prisma } from "./db";
import {
  acquireDatabaseMutationLocks,
  PRISMA_LOCKED_MUTATION_TRANSACTION_OPTIONS,
  systemDatabaseActor,
  withDatabaseContext
} from "./db-context";
import { isOperationalJobName, type OperationalJobName, type OperationalJobStatus } from "./operational-jobs";
import type { OperationalJobRecord, OperationalJobStore } from "./operational-job-runner";

export const prismaOperationalJobStore: OperationalJobStore = {
  async finish(input) {
    return withOperationalJobMutation(input.job, async (transaction) => {
      const update = await transaction.operationalJob.updateMany({
        data: {
          backlogCount: input.backlogCount,
          consecutiveFailures: input.succeeded ? 0 : { increment: 1 },
          durationMs: input.durationMs,
          failureCode: input.failureCode,
          finishedAt: input.finishedAt,
          ...(input.succeeded ? { lastSuccessAt: input.finishedAt } : {}),
          oldestBacklogAt: input.oldestBacklogAt,
          result: input.result,
          status: input.succeeded ? "SUCCEEDED" : "FAILED"
        },
        where: { job: input.job, startedAt: input.startedAt, status: "RUNNING" }
      });
      if (update.count !== 1) {
        throw new OperationalJobClaimLostError(input.job);
      }
      const record = await transaction.operationalJob.findUnique({ where: { job: input.job } });
      if (!record) {
        throw new OperationalJobClaimLostError(input.job);
      }
      return toOperationalJobRecord(record);
    });
  },

  async tryStart(input) {
    return withOperationalJobMutation(input.job, async (transaction) => {
      const existing = await transaction.operationalJob.findUnique({ where: { job: input.job } });
      const runningCutoff = new Date(input.startedAt.getTime() - input.timeoutMs);
      if (existing?.status === "RUNNING" && existing.startedAt > runningCutoff) {
        return null;
      }
      const record = await transaction.operationalJob.upsert({
        create: {
          job: input.job,
          lastAttemptAt: input.startedAt,
          startedAt: input.startedAt,
          status: "RUNNING"
        },
        update: {
          ...(existing?.status === "RUNNING" ? { consecutiveFailures: { increment: 1 } } : {}),
          durationMs: null,
          failureCode: null,
          finishedAt: null,
          lastAttemptAt: input.startedAt,
          result: null,
          startedAt: input.startedAt,
          status: "RUNNING"
        },
        where: { job: input.job }
      });
      return toOperationalJobRecord(record);
    });
  }
};

function withOperationalJobMutation<TResult>(
  job: OperationalJobName,
  operation: (transaction: Prisma.TransactionClient) => Promise<TResult>
): Promise<TResult> {
  return withDatabaseContext({
    actor: systemDatabaseActor(),
    client: prisma,
    operation: async (transaction) => {
      await acquireDatabaseMutationLocks(transaction, [`job:${job}`]);
      return operation(transaction);
    },
    options: PRISMA_LOCKED_MUTATION_TRANSACTION_OPTIONS
  });
}

export async function getPrismaOperationalJobs(): Promise<readonly OperationalJobRecord[]> {
  const records = await withDatabaseContext({
    actor: systemDatabaseActor(),
    client: prisma,
    operation: (transaction) => transaction.operationalJob.findMany()
  });
  return records.map(toOperationalJobRecord);
}

function toOperationalJobRecord(record: OperationalJob): OperationalJobRecord {
  return {
    backlogCount: record.backlogCount,
    consecutiveFailures: record.consecutiveFailures,
    durationMs: record.durationMs,
    failureCode: record.failureCode,
    finishedAt: record.finishedAt,
    job: parseOperationalJobName(record.job),
    lastAttemptAt: record.lastAttemptAt,
    lastSuccessAt: record.lastSuccessAt,
    oldestBacklogAt: record.oldestBacklogAt,
    result: record.result,
    startedAt: record.startedAt,
    status: parseOperationalJobStatus(record.status)
  };
}

function parseOperationalJobName(value: string): OperationalJobName {
  if (isOperationalJobName(value)) {
    return value;
  }
  throw new InvalidOperationalJobRecordError("job", value);
}

function parseOperationalJobStatus(value: string): OperationalJobStatus {
  if (value === "FAILED" || value === "RUNNING" || value === "SUCCEEDED") {
    return value;
  }
  throw new InvalidOperationalJobRecordError("status", value);
}

class OperationalJobClaimLostError extends Error {
  public constructor(job: OperationalJobName) {
    super(`Operational job claim lost: ${job}`);
    this.name = "OperationalJobClaimLostError";
  }
}

class InvalidOperationalJobRecordError extends Error {
  public constructor(field: string, value: string) {
    super(`Invalid operational job ${field}: ${value}`);
    this.name = "InvalidOperationalJobRecordError";
  }
}
