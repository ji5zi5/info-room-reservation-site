import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import type {
  DiscordInteractionJobClaim,
  DiscordInteractionJobStore
} from "./discord-interaction-job-runner";
import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";
import { withDiscordReservationMessageSystemContext } from "./prisma-discord-reservation-message-context";

export const DISCORD_INTERACTION_CLAIM_BATCH_SIZE = 20;
export const DISCORD_INTERACTION_CLAIM_LEASE_MS = 120_000;

export type DiscordInteractionEnqueueInput = {
  readonly commandDigest: string;
  readonly discordActorId: string;
  readonly interactionId: string;
  readonly intent: string;
  readonly ipHash: string;
  readonly localActorId: string;
  readonly renderedEpoch: number;
  readonly reservationId: string;
  readonly sourceApplicationId: string;
  readonly sourceChannelId: string;
  readonly sourceGuildId: string;
  readonly sourceMessageId: string;
};

export type DiscordInteractionStageInput = DiscordInteractionEnqueueInput & {
  readonly activationDeadline: Date;
};

export type DiscordInteractionEnqueueResult =
  | { readonly kind: "duplicate" }
  | { readonly kind: "enqueued" }
  | { readonly kind: "security_conflict" };

export type DiscordInteractionHandshakeSnapshot = {
  readonly commandDigest: string;
  readonly handshakeStatus: "ABANDONED_UNACKED" | "ACKNOWLEDGED" | "STAGED";
  readonly status: "ABANDONED" | "PENDING";
};

export type DiscordInteractionActivationResult =
  | { readonly kind: "not_pending" }
  | { readonly kind: "pending" }
  | { readonly kind: "security_conflict" };

export type DiscordInteractionSettlementResult =
  | { readonly kind: "abandoned" }
  | { readonly kind: "missing" }
  | { readonly kind: "pending" }
  | { readonly kind: "security_conflict" };

export type DiscordInteractionBacklogSummary = {
  readonly count: number;
  readonly oldestAgeMs: number | null;
  readonly oldestCreatedAt: Date | null;
};

const CONTROL_ID = "discord-operations";
const BACKLOG_STATUSES = ["PENDING", "PROCESSING", "RETRY"] as const;
const HANDSHAKE_TRANSACTION_OPTIONS = { maxWait: 100, timeout: 800 } as const;

export function stageDiscordInteractionJob(
  input: DiscordInteractionStageInput
): Promise<DiscordInteractionEnqueueResult> {
  return withBoundedHandshakeContext(async (transaction) => {
    if (!Number.isFinite(input.activationDeadline.getTime())) {
      throw new DiscordInteractionActivationDeadlineError(input.activationDeadline);
    }
    const [inserted] = await transaction.$queryRaw<readonly { readonly count: number }[]>(Prisma.sql`
      WITH clock AS (SELECT clock_timestamp() AS "now"),
      inserted AS (
        INSERT INTO "DiscordInteractionJob" (
          "interactionId", "reservationId", "sourceApplicationId", "sourceGuildId", "sourceChannelId",
          "sourceMessageId", "discordActorId", "localActorId", "renderedEpoch", "intent", "ipHash",
          "commandDigest", "handshakeStatus", "status", "nextAttemptAt", "errorCode", "lastError", "updatedAt"
        )
        SELECT
          ${input.interactionId}, ${input.reservationId}, ${input.sourceApplicationId}, ${input.sourceGuildId},
          ${input.sourceChannelId}, ${input.sourceMessageId}, ${input.discordActorId}, ${input.localActorId},
          ${input.renderedEpoch}, ${input.intent}, ${input.ipHash}, ${input.commandDigest},
          CASE WHEN ${input.activationDeadline} > clock."now" THEN 'STAGED' ELSE 'ABANDONED_UNACKED' END,
          CASE WHEN ${input.activationDeadline} > clock."now" THEN 'PENDING' ELSE 'ABANDONED' END,
          CASE WHEN ${input.activationDeadline} > clock."now" THEN ${input.activationDeadline} ELSE NULL END,
          CASE WHEN ${input.activationDeadline} > clock."now" THEN NULL ELSE 'discord_ack_deadline_exceeded' END,
          CASE WHEN ${input.activationDeadline} > clock."now" THEN NULL ELSE 'ACK_DEADLINE' END,
          clock."now"
        FROM clock
        ON CONFLICT ("interactionId") DO NOTHING
        RETURNING 1
      )
      SELECT COUNT(*)::int AS "count" FROM inserted
    `);
    if (inserted?.count === 1) {
      return { kind: "enqueued" };
    }
    const existing = await transaction.discordInteractionJob.findUnique({
      select: { commandDigest: true },
      where: { interactionId: input.interactionId }
    });
    if (existing === null) {
      throw new DiscordInteractionJobInvariantError(input.interactionId);
    }
    return existing.commandDigest === input.commandDigest
      ? { kind: "duplicate" }
      : { kind: "security_conflict" };
  });
}

export function activateDiscordInteractionJob(input: {
  readonly commandDigest: string;
  readonly interactionId: string;
}): Promise<DiscordInteractionActivationResult> {
  return withBoundedHandshakeContext(async (transaction) => {
    const activated = await transaction.$executeRaw(Prisma.sql`
      WITH clock AS (SELECT clock_timestamp() AS "now")
      UPDATE "DiscordInteractionJob" AS job
      SET "handshakeStatus" = 'ACKNOWLEDGED', "nextAttemptAt" = clock."now", "updatedAt" = clock."now"
      FROM clock
      WHERE job."commandDigest" = ${input.commandDigest}
        AND job."handshakeStatus" = 'STAGED'
        AND job."interactionId" = ${input.interactionId}
        AND job."nextAttemptAt" > clock."now"
        AND job."status" = 'PENDING'
    `);
    if (activated === 1) return { kind: "pending" };
    return activationResult(await readHandshakeInTransaction(transaction, input.interactionId), input.commandDigest);
  });
}

export function settleDiscordInteractionHandshake(input: {
  readonly commandDigest: string;
  readonly interactionId: string;
}): Promise<DiscordInteractionSettlementResult> {
  return withBoundedHandshakeContext(async (transaction) => {
    const [winner] = await transaction.$queryRaw<readonly DiscordInteractionHandshakeSnapshot[]>(Prisma.sql`
      WITH winner AS MATERIALIZED (
        SELECT "commandDigest", "handshakeStatus", "status"
        FROM "DiscordInteractionJob"
        WHERE "interactionId" = ${input.interactionId}
        FOR UPDATE
      ),
      settled AS (
        UPDATE "DiscordInteractionJob" AS job
        SET
          "errorCode" = 'discord_ack_deadline_exceeded',
          "handshakeStatus" = 'ABANDONED_UNACKED',
          "lastError" = 'ACK_DEADLINE',
          "nextAttemptAt" = NULL,
          "status" = 'ABANDONED',
          "updatedAt" = clock_timestamp()
        FROM winner
        WHERE job."interactionId" = ${input.interactionId}
          AND winner."commandDigest" = ${input.commandDigest}
          AND winner."handshakeStatus" = 'STAGED'
          AND winner."status" = 'PENDING'
        RETURNING job."commandDigest", job."handshakeStatus", job."status"
      )
      SELECT "commandDigest", "handshakeStatus", "status" FROM settled
      UNION ALL
      SELECT "commandDigest", "handshakeStatus", "status" FROM winner
      WHERE NOT EXISTS (SELECT 1 FROM settled)
      LIMIT 1
    `);
    if (winner === undefined) return { kind: "missing" };
    if (winner.commandDigest !== input.commandDigest) return { kind: "security_conflict" };
    return winner.handshakeStatus === "ACKNOWLEDGED" && winner.status === "PENDING"
      ? { kind: "pending" }
      : { kind: "abandoned" };
  });
}

export function readDiscordInteractionHandshake(
  interactionId: string
): Promise<DiscordInteractionHandshakeSnapshot | null> {
  return withDiscordReservationMessageSystemContext((transaction) =>
    readHandshakeInTransaction(transaction, interactionId)
  );
}

export function getDiscordInteractionBacklogSummary(now: Date): Promise<DiscordInteractionBacklogSummary> {
  return withDiscordReservationMessageSystemContext(async (transaction) => {
    const summary = await transaction.discordInteractionJob.aggregate({
      _count: { _all: true },
      _min: { createdAt: true },
      where: { handshakeStatus: "ACKNOWLEDGED", status: { in: [...BACKLOG_STATUSES] } }
    });
    const oldestCreatedAt = summary._min.createdAt;
    return {
      count: summary._count._all,
      oldestAgeMs: oldestCreatedAt === null ? null : Math.max(0, now.getTime() - oldestCreatedAt.getTime()),
      oldestCreatedAt
    };
  });
}

export const prismaDiscordInteractionJobStore: DiscordInteractionJobStore = {
  claim: claimDiscordInteractionJobs,
  completeFailure: (input) => finishClaim(input.claim, {
    errorCode: input.result.errorCode,
    lastError: input.result.errorType,
    nextAttemptAt: input.result.nextAttemptAt,
    status: input.result.status
  }),
  completeStale: (input) => finishClaim(input.claim, {
    errorCode: input.errorCode ?? "discord_control_stale",
    lastError: input.errorCode === undefined ? "CONTROL_EPOCH" : "APPLICATION_BINDING_REVIEW",
    nextAttemptAt: null,
    status: "STALE",
    terminalResult: input.terminalResult
  }),
  completeSuccess: (input) => finishClaim(input.claim, {
    errorCode: null,
    lastError: null,
    nextAttemptAt: null,
    status: "SUCCEEDED",
    terminalResult: input.terminalResult
  }),
  isDispatchAllowed: isDiscordInteractionDispatchAllowed
};

async function claimDiscordInteractionJobs(
  now: Date,
  interactionId?: string
): Promise<readonly DiscordInteractionJobClaim[]> {
  return withDiscordReservationMessageSystemContext(async (transaction) => {
    const [control] = await transaction.$queryRaw<readonly ControlState[]>(Prisma.sql`
      SELECT "enabled", "epoch"
      FROM "DiscordOperationsControl"
      WHERE "id" = ${CONTROL_ID}
      FOR SHARE
    `);
    if (control?.enabled !== true) {
      return [];
    }
    const claimLimit = interactionId === undefined ? DISCORD_INTERACTION_CLAIM_BATCH_SIZE : 1;
    const claimable = claimableWhere(now, new Date(now.getTime() - DISCORD_INTERACTION_CLAIM_LEASE_MS));
    const candidates = await transaction.discordInteractionJob.findMany({
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }, { interactionId: "asc" }],
      take: claimLimit,
      where: {
        ...claimable,
        ...(interactionId === undefined ? {} : { interactionId }),
        handshakeStatus: "ACKNOWLEDGED",
        renderedEpoch: control.epoch
      }
    });
    const claims: DiscordInteractionJobClaim[] = [];
    for (const candidate of candidates.slice(0, claimLimit)) {
      const claimId = randomUUID();
      const updated = await transaction.discordInteractionJob.updateMany({
        data: {
          attempts: { increment: 1 },
          claimId,
          claimedAt: now,
          errorCode: null,
          lastError: null,
          status: "PROCESSING"
        },
        where: {
          ...claimable,
          handshakeStatus: "ACKNOWLEDGED",
          interactionId: candidate.interactionId,
          renderedEpoch: control.epoch
        }
      });
      if (updated.count === 1) {
        claims.push({
          attempts: candidate.attempts + 1,
          claimId,
          commandDigest: candidate.commandDigest,
          discordActorId: candidate.discordActorId,
          interactionId: candidate.interactionId,
          intent: candidate.intent,
          ipHash: candidate.ipHash,
          localActorId: candidate.localActorId,
          renderedEpoch: control.epoch,
          reservationId: candidate.reservationId,
          sourceApplicationId: candidate.sourceApplicationId,
          sourceChannelId: candidate.sourceChannelId,
          sourceGuildId: candidate.sourceGuildId,
          sourceMessageId: candidate.sourceMessageId
        });
      }
    }
    return claims;
  });
}

type ControlState = {
  readonly enabled: boolean;
  readonly epoch: number;
};

function withBoundedHandshakeContext<TResult>(
  operation: (transaction: Prisma.TransactionClient) => Promise<TResult>
): Promise<TResult> {
  return withDatabaseContext({
    actor: systemDatabaseActor(),
    client: prisma,
    operation: async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('statement_timeout', '700ms', true)`;
      await transaction.$executeRaw`SELECT set_config('lock_timeout', '700ms', true)`;
      return operation(transaction);
    },
    options: HANDSHAKE_TRANSACTION_OPTIONS
  });
}

async function readHandshakeInTransaction(
  transaction: Prisma.TransactionClient,
  interactionId: string
): Promise<DiscordInteractionHandshakeSnapshot | null> {
  const row = await transaction.discordInteractionJob.findUnique({
    select: { commandDigest: true, handshakeStatus: true, status: true },
    where: { interactionId }
  });
  if (row === null) return null;
  if (
    (row.handshakeStatus === "STAGED" && row.status === "PENDING") ||
    (row.handshakeStatus === "ACKNOWLEDGED" && row.status === "PENDING") ||
    (row.handshakeStatus === "ABANDONED_UNACKED" && row.status === "ABANDONED")
  ) {
    return { commandDigest: row.commandDigest, handshakeStatus: row.handshakeStatus, status: row.status };
  }
  return null;
}

function activationResult(
  snapshot: DiscordInteractionHandshakeSnapshot | null,
  commandDigest: string
): DiscordInteractionActivationResult {
  if (snapshot?.commandDigest !== commandDigest) {
    return snapshot === null ? { kind: "not_pending" } : { kind: "security_conflict" };
  }
  return snapshot.handshakeStatus === "ACKNOWLEDGED" && snapshot.status === "PENDING"
    ? { kind: "pending" }
    : { kind: "not_pending" };
}

async function isDiscordInteractionDispatchAllowed(claim: DiscordInteractionJobClaim): Promise<boolean> {
  return withDiscordReservationMessageSystemContext(async (transaction) => {
    const [control, job] = await Promise.all([
      transaction.discordOperationsControl.findUnique({
        select: { enabled: true, epoch: true },
        where: { id: CONTROL_ID }
      }),
      transaction.discordInteractionJob.findUnique({
        select: { claimId: true, renderedEpoch: true, status: true },
        where: { interactionId: claim.interactionId }
      })
    ]);
    return control?.enabled === true &&
      control.epoch === claim.renderedEpoch &&
      job?.status === "PROCESSING" &&
      job.claimId === claim.claimId &&
      job.renderedEpoch === control.epoch;
  });
}

function claimableWhere(now: Date, staleBefore: Date): Prisma.DiscordInteractionJobWhereInput {
  return {
    OR: [
      { nextAttemptAt: { lte: now }, status: { in: ["PENDING", "RETRY"] } },
      { claimedAt: { lte: staleBefore }, status: "PROCESSING" }
    ]
  };
}

function finishClaim(
  claim: DiscordInteractionJobClaim,
  data: Prisma.DiscordInteractionJobUpdateManyMutationInput
): Promise<void> {
  return withDiscordReservationMessageSystemContext(async (transaction) => {
    const result = await transaction.discordInteractionJob.updateMany({
      data: { ...data, claimId: null, claimedAt: null },
      where: { claimId: claim.claimId, interactionId: claim.interactionId, status: "PROCESSING" }
    });
    if (result.count !== 1) {
      throw new DiscordInteractionClaimLostError(claim.interactionId);
    }
  });
}

class DiscordInteractionJobInvariantError extends Error {
  public override readonly name = "DiscordInteractionJobInvariantError";
  public constructor(public readonly interactionId: string) {
    super(`Discord interaction job ${interactionId} disappeared after a duplicate insert`);
  }
}

class DiscordInteractionClaimLostError extends Error {
  public override readonly name = "DiscordInteractionClaimLostError";
  public constructor(public readonly interactionId: string) {
    super(`Discord interaction claim for ${interactionId} is no longer current`);
  }
}

class DiscordInteractionActivationDeadlineError extends Error {
  public override readonly name = "DiscordInteractionActivationDeadlineError";
  public constructor(public readonly deadline: Date) {
    super("Discord interaction activation deadline must be a valid date");
  }
}
