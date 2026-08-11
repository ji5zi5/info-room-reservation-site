import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { withDiscordReservationMessageSystemContext } from "./prisma-discord-reservation-message-context";

export const DISCORD_CLAIM_BATCH_SIZE = 20;
export const DISCORD_CLAIM_LEASE_MS = 120_000;

export type DiscordInitialSendClaim = Readonly<{
  attempts: number;
  claimId: string;
  nonce: string;
  outcome: string | null;
  reservationId: string;
}>;

export type DiscordMessageSyncClaim = Readonly<{
  attempts: number;
  channelId: string;
  claimId: string;
  guildId: string;
  messageId: string;
  reservationId: string;
  revision: number;
}>;

export async function claimInitialSend(
  now: Date,
  reservationId: string
): Promise<DiscordInitialSendClaim | null> {
  const claims = await claimInitialSendsWithLimit(now, reservationId, 1);
  return claims[0] ?? null;
}

export function claimInitialSends(now: Date): Promise<readonly DiscordInitialSendClaim[]> {
  return claimInitialSendsWithLimit(now, undefined, DISCORD_CLAIM_BATCH_SIZE);
}

export async function claimMessageSync(
  now: Date,
  reservationId: string
): Promise<DiscordMessageSyncClaim | null> {
  const claims = await claimMessageSyncsWithLimit(now, reservationId, 1);
  return claims[0] ?? null;
}

export function claimMessageSyncs(now: Date): Promise<readonly DiscordMessageSyncClaim[]> {
  return claimMessageSyncsWithLimit(now, undefined, DISCORD_CLAIM_BATCH_SIZE);
}

async function claimInitialSendsWithLimit(
  now: Date,
  reservationId: string | undefined,
  limit: number
): Promise<readonly DiscordInitialSendClaim[]> {
  return withDiscordReservationMessageSystemContext(async (transaction) => {
    const claimable = initialSendClaimableWhere(now, new Date(now.getTime() - DISCORD_CLAIM_LEASE_MS));
    const candidates = await transaction.discordReservationMessage.findMany({
      orderBy: [{ initialSendNextAttemptAt: "asc" }, { reservationId: "asc" }],
      select: { initialSendAttempts: true, initialSendOutcome: true, nonce: true, reservationId: true },
      take: limit,
      where: { ...claimable, ...(reservationId === undefined ? {} : { reservationId }) }
    });
    const claims: DiscordInitialSendClaim[] = [];
    for (const candidate of candidates.slice(0, limit)) {
      const claimId = randomUUID();
      const result = await transaction.discordReservationMessage.updateMany({
        data: {
          initialSendAttempts: { increment: 1 },
          initialSendClaimedAt: now,
          initialSendClaimId: claimId,
          initialSendError: null,
          initialSendStatus: "SENDING"
        },
        where: { ...claimable, reservationId: candidate.reservationId }
      });
      if (result.count === 1) {
        claims.push({
          attempts: candidate.initialSendAttempts + 1,
          claimId,
          nonce: candidate.nonce,
          outcome: candidate.initialSendOutcome,
          reservationId: candidate.reservationId
        });
      }
    }
    return claims;
  });
}

async function claimMessageSyncsWithLimit(
  now: Date,
  reservationId: string | undefined,
  limit: number
): Promise<readonly DiscordMessageSyncClaim[]> {
  return withDiscordReservationMessageSystemContext(async (transaction) => {
    const claimable = syncClaimableWhere(now, new Date(now.getTime() - DISCORD_CLAIM_LEASE_MS));
    const candidates = await transaction.discordReservationMessage.findMany({
      orderBy: [{ syncNextAttemptAt: "asc" }, { reservationId: "asc" }],
      take: limit,
      where: {
        ...claimable,
        channelId: { not: null },
        guildId: { not: null },
        messageId: { not: null },
        ...(reservationId === undefined ? {} : { reservationId })
      }
    });
    const claims: DiscordMessageSyncClaim[] = [];
    for (const candidate of candidates.slice(0, limit)) {
      if (!candidate.channelId || !candidate.guildId || !candidate.messageId || candidate.messageRevision <= candidate.syncedRevision) {
        continue;
      }
      const claimId = randomUUID();
      const result = await transaction.discordReservationMessage.updateMany({
        data: {
          syncAttempts: { increment: 1 },
          syncClaimedAt: now,
          syncClaimId: claimId,
          syncClaimRevision: candidate.messageRevision,
          syncError: null,
          syncStatus: "SYNCING"
        },
        where: { ...claimable, messageRevision: candidate.messageRevision, reservationId: candidate.reservationId }
      });
      if (result.count === 1) {
        claims.push({
          attempts: candidate.syncAttempts + 1,
          channelId: candidate.channelId,
          claimId,
          guildId: candidate.guildId,
          messageId: candidate.messageId,
          reservationId: candidate.reservationId,
          revision: candidate.messageRevision
        });
      }
    }
    return claims;
  });
}

function initialSendClaimableWhere(
  now: Date,
  staleBefore: Date
): Prisma.DiscordReservationMessageWhereInput {
  return {
    OR: [
      { initialSendNextAttemptAt: { lte: now }, initialSendStatus: { in: ["PENDING", "RETRY"] } },
      { initialSendClaimedAt: { lte: staleBefore }, initialSendStatus: "SENDING" }
    ]
  };
}

function syncClaimableWhere(now: Date, staleBefore: Date): Prisma.DiscordReservationMessageWhereInput {
  return {
    OR: [
      { syncNextAttemptAt: { lte: now }, syncStatus: { in: ["PENDING", "RETRY"] } },
      { syncClaimedAt: { lte: staleBefore }, syncStatus: "SYNCING" }
    ]
  };
}
