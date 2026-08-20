import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";
import {
  discordAdminCommandResultSchema,
  type DiscordAdminCommandResult
} from "./discord-admin-command-results";

const DELIVERY_BATCH_SIZE = 20;
const DELIVERY_LEASE_MS = 120_000;
const MAX_DELIVERY_ATTEMPTS = 8;

export type DiscordAdminResultDeliveryClaim = {
  readonly attempts: number;
  readonly channelId: string;
  readonly claimId: string;
  readonly id: string;
  readonly result: DiscordAdminCommandResult;
};

export function claimDiscordAdminResultDeliveries(now: Date): Promise<readonly DiscordAdminResultDeliveryClaim[]> {
  return withSystemContext(async (transaction) => {
    const leaseExpiredAt = new Date(now.getTime() - DELIVERY_LEASE_MS);
    const rows = await transaction.discordAdminCommandJob.findMany({
      orderBy: [{ resultDeliveryNextAttemptAt: "asc" }, { createdAt: "asc" }],
      take: DELIVERY_BATCH_SIZE,
      where: {
        OR: [
          { resultDeliveryNextAttemptAt: { lte: now }, resultDeliveryStatus: { in: ["PENDING", "RETRY"] } },
          { resultDeliveryClaimedAt: { lte: leaseExpiredAt }, resultDeliveryStatus: "SENDING" }
        ],
        terminalResult: { not: Prisma.DbNull }
      }
    });
    const claims: DiscordAdminResultDeliveryClaim[] = [];
    for (const row of rows) {
      const result = discordAdminCommandResultSchema.safeParse(row.terminalResult);
      if (!result.success) continue;
      const claimId = randomUUID();
      const updated = await transaction.discordAdminCommandJob.updateMany({
        data: { resultDeliveryAttempts: { increment: 1 }, resultDeliveryClaimId: claimId, resultDeliveryClaimedAt: now, resultDeliveryStatus: "SENDING" },
        where: { id: row.id, resultDeliveryStatus: row.resultDeliveryStatus, updatedAt: row.updatedAt }
      });
      if (updated.count === 1) claims.push({
        attempts: row.resultDeliveryAttempts + 1,
        channelId: row.sourceChannelId,
        claimId,
        id: row.id,
        result: result.data
      });
    }
    return claims;
  });
}

export function claimExactDiscordAdminResultDelivery(input: {
  readonly executionInteractionId: string;
  readonly now: Date;
}): Promise<DiscordAdminResultDeliveryClaim | null> {
  return withSystemContext(async (transaction) => {
    const row = await transaction.discordAdminCommandJob.findUnique({
      where: { executionInteractionId: input.executionInteractionId }
    });
    if (
      row === null || row.resultDeliveryNextAttemptAt === null ||
      row.resultDeliveryNextAttemptAt.getTime() > input.now.getTime() ||
      (row.resultDeliveryStatus !== "PENDING" && row.resultDeliveryStatus !== "RETRY")
    ) return null;
    const result = discordAdminCommandResultSchema.safeParse(row.terminalResult);
    if (!result.success) return null;
    const claimId = randomUUID();
    const updated = await transaction.discordAdminCommandJob.updateMany({
      data: {
        resultDeliveryAttempts: { increment: 1 },
        resultDeliveryClaimId: claimId,
        resultDeliveryClaimedAt: input.now,
        resultDeliveryStatus: "SENDING"
      },
      where: { id: row.id, resultDeliveryStatus: row.resultDeliveryStatus, updatedAt: row.updatedAt }
    });
    return updated.count === 1
      ? {
          attempts: row.resultDeliveryAttempts + 1,
          channelId: row.sourceChannelId,
          claimId,
          id: row.id,
          result: result.data
        }
      : null;
  });
}

export function completeDiscordAdminResultDelivery(input: {
  readonly claim: DiscordAdminResultDeliveryClaim;
  readonly messageId: string;
}): Promise<void> {
  return withSystemContext(async (transaction) => {
    await transaction.discordAdminCommandJob.updateMany({
      data: {
        resultDeliveryClaimId: null,
        resultDeliveryClaimedAt: null,
        resultDeliveryNextAttemptAt: null,
        resultDeliveryStatus: "SENT",
        resultMessageId: input.messageId
      },
      where: { id: input.claim.id, resultDeliveryClaimId: input.claim.claimId, resultDeliveryStatus: "SENDING" }
    });
  });
}

export function failDiscordAdminResultDelivery(input: {
  readonly claim: DiscordAdminResultDeliveryClaim;
  readonly errorCode: string;
  readonly now: Date;
}): Promise<void> {
  const abandoned = input.claim.attempts >= MAX_DELIVERY_ATTEMPTS;
  const delayMinutes = Math.min(60, 2 ** Math.min(input.claim.attempts - 1, 5));
  return withSystemContext(async (transaction) => {
    await transaction.discordAdminCommandJob.updateMany({
      data: {
        errorCode: safeIdentifier(input.errorCode),
        resultDeliveryClaimId: null,
        resultDeliveryClaimedAt: null,
        resultDeliveryNextAttemptAt: abandoned ? null : new Date(input.now.getTime() + delayMinutes * 60_000),
        resultDeliveryStatus: abandoned ? "FAILED" : "RETRY"
      },
      where: { id: input.claim.id, resultDeliveryClaimId: input.claim.claimId, resultDeliveryStatus: "SENDING" }
    });
  });
}

function safeIdentifier(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,64}$/u.test(value) ? value : "discord_result_delivery_failed";
}

function withSystemContext<TResult>(operation: (transaction: Prisma.TransactionClient) => Promise<TResult>): Promise<TResult> {
  return withDatabaseContext({ actor: systemDatabaseActor(), client: prisma, operation });
}
