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
  readonly handshakeStatus: "ACKNOWLEDGED" | "STAGED";
  readonly interactionId: string;
  readonly intent: string;
  readonly ipHash: string;
  readonly localActorId: string;
  readonly renderedEpoch: number;
  readonly reservationId: string;
  readonly sourceChannelId: string;
  readonly sourceGuildId: string;
  readonly sourceMessageId: string;
};

export type DiscordInteractionEnqueueResult =
  | { readonly kind: "duplicate" }
  | { readonly kind: "enqueued" }
  | { readonly kind: "security_conflict" };

export type DiscordInteractionBacklogSummary = {
  readonly count: number;
  readonly oldestAgeMs: number | null;
  readonly oldestCreatedAt: Date | null;
};

const CONTROL_ID = "discord-operations";
const BACKLOG_STATUSES = ["PENDING", "PROCESSING", "RETRY"] as const;

export function enqueueDiscordInteractionJob(
  input: DiscordInteractionEnqueueInput
): Promise<DiscordInteractionEnqueueResult> {
  return withDiscordReservationMessageSystemContext(async (transaction) => {
    const inserted = await transaction.discordInteractionJob.createMany({ data: input, skipDuplicates: true });
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

export function getDiscordInteractionBacklogSummary(now: Date): Promise<DiscordInteractionBacklogSummary> {
  return withDiscordReservationMessageSystemContext(async (transaction) => {
    const summary = await transaction.discordInteractionJob.aggregate({
      _count: { _all: true },
      _min: { createdAt: true },
      where: { status: { in: [...BACKLOG_STATUSES] } }
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
    errorCode: "discord_control_stale",
    lastError: "CONTROL_EPOCH",
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
