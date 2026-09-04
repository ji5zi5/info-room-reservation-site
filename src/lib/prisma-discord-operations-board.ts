import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";

const BOARD_ID = "discord-operations-board";
const CLAIM_LEASE_MS = 120_000;

export type DiscordOperationsBoardClaim = {
  readonly attempts: number;
  readonly channelId: string | null;
  readonly claimId: string;
  readonly guildId: string | null;
  readonly messageId: string | null;
  readonly renderedDate: string | null;
  readonly revision: number;
  readonly stateDigest: string | null;
};

export function requestDiscordOperationsBoardSync(now: Date): Promise<void> {
  return withSystemContext(async (transaction) => {
    await transaction.discordOperationsBoard.upsert({
      create: { id: BOARD_ID, nextAttemptAt: now, syncStatus: "PENDING" },
      update: {},
      where: { id: BOARD_ID }
    });
    await transaction.discordOperationsBoard.updateMany({
      data: { nextAttemptAt: now, syncStatus: "PENDING" },
      where: refreshableBoardWhere(now)
    });
  });
}

export function claimDiscordOperationsBoardSync(input: {
  readonly force: boolean;
  readonly now: Date;
}): Promise<DiscordOperationsBoardClaim | null> {
  return withSystemContext(async (transaction) => {
    if (input.force) {
      await transaction.discordOperationsBoard.updateMany({
        data: { nextAttemptAt: input.now, syncStatus: "PENDING" },
        where: refreshableBoardWhere(input.now)
      });
    }
    const board = await transaction.discordOperationsBoard.findUnique({ where: { id: BOARD_ID } });
    if (board === null) return null;
    const leaseExpiredAt = new Date(input.now.getTime() - CLAIM_LEASE_MS);
    const eligible = (
      (board.syncStatus === "PENDING" || board.syncStatus === "RETRY") &&
      (board.nextAttemptAt === null || board.nextAttemptAt.getTime() <= input.now.getTime())
    ) || (
      board.syncStatus === "SYNCING" &&
      board.claimedAt !== null &&
      board.claimedAt.getTime() <= leaseExpiredAt.getTime()
    );
    if (!eligible) return null;
    const claimId = randomUUID();
    const updated = await transaction.discordOperationsBoard.updateMany({
      data: { claimId, claimedAt: input.now, syncAttempts: { increment: 1 }, syncStatus: "SYNCING" },
      where: { id: BOARD_ID, syncStatus: board.syncStatus, updatedAt: board.updatedAt }
    });
    return updated.count === 1
      ? {
          attempts: board.syncAttempts + 1,
          channelId: board.channelId,
          claimId,
          guildId: board.guildId,
          messageId: board.messageId,
          renderedDate: board.renderedDate,
          revision: board.revision,
          stateDigest: board.stateDigest
        }
      : null;
  });
}

export function completeDiscordOperationsBoardSync(input: {
  readonly channelId: string;
  readonly claim: DiscordOperationsBoardClaim;
  readonly guildId: string;
  readonly messageId: string;
  readonly now: Date;
  readonly renderedDate: string;
  readonly revision: number;
  readonly stateDigest: string;
}): Promise<boolean> {
  return withSystemContext(async (transaction) => (await transaction.discordOperationsBoard.updateMany({
    data: {
      channelId: input.channelId,
      claimId: null,
      claimedAt: null,
      guildId: input.guildId,
      lastError: null,
      lastSyncedAt: input.now,
      messageId: input.messageId,
      nextAttemptAt: null,
      renderedDate: input.renderedDate,
      revision: input.revision,
      stateDigest: input.stateDigest,
      syncStatus: "SYNCED"
    },
    where: { claimId: input.claim.claimId, id: BOARD_ID, syncStatus: "SYNCING" }
  })).count === 1);
}

export function completeUnchangedDiscordOperationsBoardSync(input: {
  readonly claim: DiscordOperationsBoardClaim;
  readonly now: Date;
}): Promise<boolean> {
  return withSystemContext(async (transaction) => (await transaction.discordOperationsBoard.updateMany({
    data: { claimId: null, claimedAt: null, lastError: null, lastSyncedAt: input.now, nextAttemptAt: null, syncStatus: "SYNCED" },
    where: { claimId: input.claim.claimId, id: BOARD_ID, syncStatus: "SYNCING" }
  })).count === 1);
}

export function failDiscordOperationsBoardSync(input: {
  readonly claim: DiscordOperationsBoardClaim;
  readonly errorCode: string;
  readonly now: Date;
}): Promise<void> {
  const delayMinutes = Math.min(60, Math.max(1, 2 ** Math.min(input.claim.attempts - 1, 5)));
  return withSystemContext(async (transaction) => {
    await transaction.discordOperationsBoard.updateMany({
      data: {
        claimId: null,
        claimedAt: null,
        lastError: safeIdentifier(input.errorCode),
        nextAttemptAt: new Date(input.now.getTime() + delayMinutes * 60_000),
        syncStatus: "RETRY"
      },
      where: { claimId: input.claim.claimId, id: BOARD_ID, syncStatus: "SYNCING" }
    });
  });
}

export function isCurrentDiscordOperationsBoardControl(input: {
  readonly channelId: string;
  readonly guildId: string;
  readonly messageId: string;
  readonly revision: number;
}): Promise<boolean> {
  return withSystemContext(async (transaction) => (await transaction.discordOperationsBoard.count({
    where: {
      channelId: input.channelId,
      guildId: input.guildId,
      messageId: input.messageId,
      revision: input.revision,
      syncStatus: "SYNCED"
    }
  })) === 1);
}

function safeIdentifier(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,64}$/u.test(value) ? value : "discord_board_sync_failed";
}

function refreshableBoardWhere(now: Date): Prisma.DiscordOperationsBoardWhereInput {
  const leaseExpiredAt = new Date(now.getTime() - CLAIM_LEASE_MS);
  return {
    id: BOARD_ID,
    OR: [
      { syncStatus: { not: "SYNCING" } },
      { claimedAt: null },
      { claimedAt: { lte: leaseExpiredAt } }
    ]
  };
}

function withSystemContext<TResult>(operation: (transaction: Prisma.TransactionClient) => Promise<TResult>): Promise<TResult> {
  return withDatabaseContext({ actor: systemDatabaseActor(), client: prisma, operation });
}
