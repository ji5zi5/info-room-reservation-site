import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import type {
  DiscordInteractionJobClaim,
  DiscordInteractionJobStore
} from "./discord-interaction-job-runner";
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
  readonly activationWindowMs: number;
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

export type DiscordInteractionAbandonResult =
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

export function stageDiscordInteractionJob(
  input: DiscordInteractionStageInput
): Promise<DiscordInteractionEnqueueResult> {
  return withDiscordReservationMessageSystemContext(async (transaction) => {
    if (!Number.isFinite(input.activationWindowMs) || input.activationWindowMs <= 0 || input.activationWindowMs > 1_500) {
      throw new DiscordInteractionActivationWindowError(input.activationWindowMs);
    }
    const databaseNow = await readDatabaseNow(transaction);
    const { activationWindowMs, ...command } = input;
    const inserted = await transaction.discordInteractionJob.createMany({
      data: {
        ...command,
        handshakeStatus: "STAGED",
        nextAttemptAt: new Date(databaseNow.getTime() + activationWindowMs),
        status: "PENDING"
      },
      skipDuplicates: true
    });
    if (inserted.count === 1) {
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
  return withDiscordReservationMessageSystemContext(async (transaction) => {
    const databaseNow = await readDatabaseNow(transaction);
    const activated = await transaction.discordInteractionJob.updateMany({
      data: { handshakeStatus: "ACKNOWLEDGED", nextAttemptAt: databaseNow },
      where: {
        commandDigest: input.commandDigest,
        handshakeStatus: "STAGED",
        interactionId: input.interactionId,
        nextAttemptAt: { gt: databaseNow },
        status: "PENDING"
      }
    });
    if (activated.count === 1) return { kind: "pending" };
    return activationResult(await readHandshakeInTransaction(transaction, input.interactionId), input.commandDigest);
  });
}

export function abandonUnacknowledgedDiscordInteractionJob(input: {
  readonly commandDigest: string;
  readonly interactionId: string;
}): Promise<DiscordInteractionAbandonResult> {
  return withDiscordReservationMessageSystemContext(async (transaction) => {
    const abandoned = await transaction.discordInteractionJob.updateMany({
      data: {
        errorCode: "discord_ack_deadline_exceeded",
        handshakeStatus: "ABANDONED_UNACKED",
        lastError: "ACK_DEADLINE",
        nextAttemptAt: null,
        status: "ABANDONED"
      },
      where: {
        commandDigest: input.commandDigest,
        handshakeStatus: "STAGED",
        interactionId: input.interactionId,
        status: "PENDING"
      }
    });
    if (abandoned.count === 1) return { kind: "abandoned" };
    const snapshot = await readHandshakeInTransaction(transaction, input.interactionId);
    if (snapshot === null) return { kind: "missing" };
    if (snapshot.commandDigest !== input.commandDigest) return { kind: "security_conflict" };
    return snapshot.handshakeStatus === "ACKNOWLEDGED" && snapshot.status === "PENDING"
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

type DatabaseClock = {
  readonly now: Date;
};

async function readDatabaseNow(transaction: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await transaction.$queryRaw<readonly DatabaseClock[]>(Prisma.sql`
    SELECT CURRENT_TIMESTAMP AS "now"
  `);
  if (clock === undefined || !(clock.now instanceof Date)) throw new DiscordInteractionDatabaseClockError();
  return clock.now;
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

class DiscordInteractionActivationWindowError extends Error {
  public override readonly name = "DiscordInteractionActivationWindowError";
  public constructor(public readonly milliseconds: number) {
    super("Discord interaction activation window must be within the route deadline");
  }
}

class DiscordInteractionDatabaseClockError extends Error {
  public override readonly name = "DiscordInteractionDatabaseClockError";
  public constructor() {
    super("Discord interaction database clock was unavailable");
  }
}
