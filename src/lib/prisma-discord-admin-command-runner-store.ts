import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import type {
  DiscordAdminCommandClaim,
  DiscordAdminCommandJobStore
} from "./discord-admin-command-runner";
import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";

const CONTROL_ID = "discord-operations";
const CLAIM_BATCH_SIZE = 20;
const CLAIM_LEASE_MS = 120_000;

export const prismaDiscordAdminCommandJobStore: DiscordAdminCommandJobStore = {
  claim: claimJobs,
  completeFailure: async (input) => {
    await finishClaim(input.claim, {
      errorCode: input.errorCode,
      lastError: input.errorType,
      nextAttemptAt: input.nextAttemptAt,
      ...(input.result === null ? {} : {
        resultDeliveryNextAttemptAt: new Date(),
        resultDeliveryStatus: "PENDING",
        terminalResult: input.result
      }),
      status: input.status
    });
  },
  completeResult: async (input) => {
    await finishClaim(input.claim, {
      errorCode: null,
      lastError: null,
      nextAttemptAt: null,
      resultDeliveryNextAttemptAt: new Date(),
      resultDeliveryStatus: "PENDING",
      status: input.status,
      terminalResult: input.result
    });
  }
};

async function claimJobs(input: {
  readonly executionInteractionId?: string;
  readonly now: Date;
}): Promise<readonly DiscordAdminCommandClaim[]> {
  return withSystemContext(async (transaction) => {
    const control = await transaction.discordOperationsControl.findUnique({ where: { id: CONTROL_ID } });
    if (control?.enabled !== true) return [];
    const leaseExpiredAt = new Date(input.now.getTime() - CLAIM_LEASE_MS);
    const candidates = await transaction.discordAdminCommandJob.findMany({
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
      take: input.executionInteractionId === undefined ? CLAIM_BATCH_SIZE : 1,
      where: buildDiscordAdminCommandClaimFilter({
        ...(input.executionInteractionId === undefined ? {} : { executionInteractionId: input.executionInteractionId }),
        leaseExpiredAt,
        now: input.now
      })
    });
    const claims: DiscordAdminCommandClaim[] = [];
    for (const candidate of candidates) {
      if (candidate.executionInteractionId === null || candidate.commandDigest === null) continue;
      const claimId = randomUUID();
      const updated = await transaction.discordAdminCommandJob.updateMany({
        data: { attempts: { increment: 1 }, claimId, claimedAt: input.now, status: "PROCESSING" },
        where: { id: candidate.id, status: candidate.status, updatedAt: candidate.updatedAt }
      });
      if (updated.count === 1) claims.push({
        attempts: candidate.attempts + 1,
        claimId,
        commandDigest: candidate.commandDigest,
        discordActorId: candidate.discordActorId,
        draftIntent: candidate.draftIntent,
        executionInteractionId: candidate.executionInteractionId,
        id: candidate.id,
        ipHash: candidate.ipHash,
        localActorId: candidate.localActorId,
        reason: candidate.reason,
        sourceApplicationId: candidate.sourceApplicationId,
        sourceChannelId: candidate.sourceChannelId,
        sourceGuildId: candidate.sourceGuildId,
        sourceInteractionId: candidate.sourceInteractionId
      });
    }
    return claims;
  });
}

export function buildDiscordAdminCommandClaimFilter(input: {
  readonly executionInteractionId?: string;
  readonly leaseExpiredAt: Date;
  readonly now: Date;
}): Prisma.DiscordAdminCommandJobWhereInput {
  return {
    ...(input.executionInteractionId === undefined
      ? { executionInteractionId: { not: null } }
      : { executionInteractionId: input.executionInteractionId }),
    handshakeStatus: "ACKNOWLEDGED",
    OR: [
      { nextAttemptAt: { lte: input.now }, status: { in: ["PENDING", "RETRY"] } },
      { claimedAt: { lte: input.leaseExpiredAt }, status: "PROCESSING" }
    ]
  };
}

function finishClaim(
  claim: DiscordAdminCommandClaim,
  data: Prisma.DiscordAdminCommandJobUpdateManyMutationInput
): Promise<void> {
  return withSystemContext(async (transaction) => {
    await transaction.discordAdminCommandJob.updateMany({
      data: { ...data, claimId: null, claimedAt: null },
      where: { claimId: claim.claimId, id: claim.id, status: "PROCESSING" }
    });
  });
}

function withSystemContext<TResult>(
  operation: (transaction: Prisma.TransactionClient) => Promise<TResult>
): Promise<TResult> {
  return withDatabaseContext({ actor: systemDatabaseActor(), client: prisma, operation });
}
