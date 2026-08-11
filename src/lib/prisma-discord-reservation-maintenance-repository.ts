import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";
import type { DiscordDisablePendingClaim, DiscordDisablePendingRepository } from "./discord-disable-pending";
import {
  DISCORD_RETENTION_BATCH_SIZE,
  type DiscordRetentionCandidate,
  type DiscordRetentionRepository
} from "./discord-reservation-retention";
import { DISCORD_CLAIM_BATCH_SIZE, DISCORD_CLAIM_LEASE_MS } from "./prisma-discord-reservation-message-repository";

const DISABLED_DECISION = "DISABLED";
const ROLLBACK_ACTOR = "SYSTEM_ROLLBACK";

type DiscordReservationMaintenanceRepository = DiscordDisablePendingRepository & DiscordRetentionRepository;

export const prismaDiscordReservationMaintenanceRepository: DiscordReservationMaintenanceRepository = {
  async claimActiveMessagesForDisable(now) {
    return withSystemContext(async (transaction) => {
      const claimable = activeDisableWhere(now);
      const candidates = await transaction.discordReservationMessage.findMany({
        orderBy: [{ createdAt: "asc" }, { reservationId: "asc" }],
        select: { channelId: true, messageId: true, messageRevision: true, reservationId: true },
        take: DISCORD_CLAIM_BATCH_SIZE,
        where: claimable
      });
      const claims: DiscordDisablePendingClaim[] = [];
      for (const candidate of candidates) {
        if (candidate.channelId === null || candidate.messageId === null) {
          continue;
        }
        const claimId = randomUUID();
        const result = await transaction.discordReservationMessage.updateMany({
          data: {
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
            channelId: candidate.channelId,
            claimId,
            messageId: candidate.messageId,
            reservationId: candidate.reservationId,
            revision: candidate.messageRevision
          });
        }
      }
      return claims;
    });
  },

  async completeDisableClaim(claim, now) {
    return withSystemContext(async (transaction) => {
      const result = await transaction.discordReservationMessage.updateMany({
        data: {
          decidedAt: now,
          decision: DISABLED_DECISION,
          decisionDiscordActorId: ROLLBACK_ACTOR,
          decisionLocalActorId: ROLLBACK_ACTOR,
          syncedRevision: claim.revision,
          syncClaimedAt: null,
          syncClaimId: null,
          syncClaimRevision: null,
          syncError: null,
          syncNextAttemptAt: null,
          syncStatus: "SYNCED"
        },
        where: {
          channelId: claim.channelId,
          decision: null,
          expiresAt: { gt: now },
          initialSendStatus: "SENT",
          messageId: claim.messageId,
          messageRevision: claim.revision,
          reservationId: claim.reservationId,
          syncClaimId: claim.claimId,
          syncClaimRevision: claim.revision,
          syncStatus: "SYNCING"
        }
      });
      return result.count === 1;
    });
  },

  async deleteExpiredCandidate(candidate, now) {
    return withSystemContext(async (transaction) => {
      const result = await transaction.discordReservationMessage.deleteMany({
        where: {
          channelId: candidate.channelId,
          expiresAt: { lte: now },
          initialSendStatus: { in: ["SENT", "ABANDONED"] },
          messageId: candidate.messageId,
          reservationId: candidate.reservationId,
          syncStatus: { in: ["SYNCED", "ABANDONED"] },
          updatedAt: candidate.updatedAt
        }
      });
      return result.count === 1;
    });
  },

  async findExpiredCandidates(now) {
    return withSystemContext((transaction) => transaction.discordReservationMessage.findMany({
      orderBy: [{ expiresAt: "asc" }, { reservationId: "asc" }],
      select: { channelId: true, expiresAt: true, messageId: true, reservationId: true, updatedAt: true },
      take: DISCORD_RETENTION_BATCH_SIZE + 1,
      where: expiredTerminalWhere(now)
    }));
  },

  async releaseDisableClaim(claim) {
    return withSystemContext(async (transaction) => {
      const result = await transaction.discordReservationMessage.updateMany({
        data: {
          syncClaimedAt: null,
          syncClaimId: null,
          syncClaimRevision: null,
          syncNextAttemptAt: null,
          syncStatus: "PENDING"
        },
        where: {
          decision: null,
          messageRevision: claim.revision,
          reservationId: claim.reservationId,
          syncClaimId: claim.claimId,
          syncClaimRevision: claim.revision,
          syncStatus: "SYNCING"
        }
      });
      return result.count === 1;
    });
  }
};

function activeDisableWhere(now: Date): Prisma.DiscordReservationMessageWhereInput {
  const staleBefore = new Date(now.getTime() - DISCORD_CLAIM_LEASE_MS);
  return {
    channelId: { not: null },
    decision: null,
    expiresAt: { gt: now },
    initialSendStatus: "SENT",
    messageId: { not: null },
    OR: [
      { syncStatus: { in: ["PENDING", "RETRY", "SYNCED", "ABANDONED"] } },
      { syncClaimedAt: { lte: staleBefore }, syncStatus: "SYNCING" }
    ]
  };
}

function expiredTerminalWhere(now: Date): Prisma.DiscordReservationMessageWhereInput {
  return {
    expiresAt: { lte: now },
    initialSendStatus: { in: ["SENT", "ABANDONED"] },
    syncStatus: { in: ["SYNCED", "ABANDONED"] }
  };
}

const withSystemContext = <TResult>(
  operation: (transaction: Prisma.TransactionClient) => Promise<TResult>
): Promise<TResult> => withDatabaseContext({ actor: systemDatabaseActor(), client: prisma, operation });

export type { DiscordRetentionCandidate };
