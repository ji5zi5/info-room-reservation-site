import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import {
  RETENTION_BATCH_SIZE,
  RETENTION_EXPIRED_TEXT,
  retentionCutoff,
  type RetentionCandidateIds,
  type RetentionCounts,
  type RetentionPolicy
} from "./retention-policy";

export async function readRetentionCandidateIds(
  transaction: Prisma.TransactionClient,
  policy: RetentionPolicy,
  now: Date
): Promise<RetentionCandidateIds> {
  const reservationCutoff = retentionCutoff(now, policy.reservationReasonDays);
  const adminCutoff = retentionCutoff(now, policy.adminDetailDays);
  const sanctionCutoff = retentionCutoff(now, policy.sanctionReasonDays);
  const auditCutoff = retentionCutoff(now, policy.auditDetailDays);
  const departedCutoff = retentionCutoff(now, policy.departedUserIdentityDays);
  const [reservationReasons, adminActionDetails, sanctionReasons, auditDetails, departedUsers] =
    await Promise.all([
      reservationCutoff
        ? transaction.reservation.findMany({
            orderBy: { id: "asc" },
            select: { id: true },
            take: RETENTION_BATCH_SIZE,
            where: { reason: { not: null }, updatedAt: { lte: reservationCutoff } }
          })
        : [],
      adminCutoff
        ? transaction.adminAction.findMany({
            orderBy: { id: "asc" },
            select: { id: true },
            take: RETENTION_BATCH_SIZE,
            where: {
              OR: [
                { after: { not: null } },
                { before: { not: null } },
                { ipHash: { not: null } },
                { reason: { not: null } }
              ],
              createdAt: { lte: adminCutoff }
            }
          })
        : [],
      sanctionCutoff
        ? transaction.userSanction.findMany({
            orderBy: { id: "asc" },
            select: { id: true },
            take: RETENTION_BATCH_SIZE,
            where: {
              OR: [
                { reason: { not: RETENTION_EXPIRED_TEXT } },
                { revokedReason: { not: null } }
              ],
              createdAt: { lte: sanctionCutoff },
              status: { not: "ACTIVE" }
            }
          })
        : [],
      auditCutoff
        ? transaction.auditLog.findMany({
            orderBy: { id: "asc" },
            select: { id: true },
            take: RETENTION_BATCH_SIZE,
            where: {
              createdAt: { lte: auditCutoff },
              detail: { not: RETENTION_EXPIRED_TEXT }
            }
          })
        : [],
      departedCutoff
        ? transaction.user.findMany({
            orderBy: { id: "asc" },
            select: { id: true },
            take: RETENTION_BATCH_SIZE,
            where: {
              anonymizedAt: null,
              departedAt: { lte: departedCutoff }
            }
          })
        : []
    ]);

  return {
    adminActionDetails: sortedIds(adminActionDetails),
    auditDetails: sortedIds(auditDetails),
    departedUserIdentities: sortedIds(departedUsers),
    reservationReasons: sortedIds(reservationReasons),
    sanctionReasons: sortedIds(sanctionReasons)
  };
}

export async function applyRetentionCandidates(
  transaction: Prisma.TransactionClient,
  candidates: RetentionCandidateIds,
  now: Date,
  policy: RetentionPolicy
): Promise<RetentionCounts> {
  const [reservationReasons, adminActionDetails, sanctionReasons, auditDetails] =
    await Promise.all([
      updateReservationReasons(transaction, candidates.reservationReasons),
      updateAdminActionDetails(transaction, candidates.adminActionDetails),
      updateSanctionReasons(transaction, candidates.sanctionReasons),
      updateAuditDetails(transaction, candidates.auditDetails)
    ]);
  let departedUserIdentities = 0;
  const departedCutoff = retentionCutoff(now, policy.departedUserIdentityDays);
  if (!departedCutoff) {
    return {
      adminActionDetails,
      auditDetails,
      departedUserIdentities,
      reservationReasons,
      sanctionReasons
    };
  }
  for (const userId of candidates.departedUserIdentities) {
    const result = await transaction.user.updateMany({
      data: {
        anonymizedAt: now,
        bookingStatus: "BANNED",
        generation: 0,
        name: "탈퇴 사용자",
        restrictedUntil: null,
        restrictionReason: null,
        riroId: null,
        shadowBanProfile: "NORMAL",
        studentNumber: `ANON-${randomUUID()}`
      },
      where: {
        anonymizedAt: null,
        departedAt: { lte: departedCutoff },
        id: userId
      }
    });
    if (result.count === 0) {
      continue;
    }
    await transaction.session.deleteMany({ where: { userId } });
    departedUserIdentities += result.count;
  }
  return {
    adminActionDetails,
    auditDetails,
    departedUserIdentities,
    reservationReasons,
    sanctionReasons
  };
}

async function updateReservationReasons(
  transaction: Prisma.TransactionClient,
  ids: readonly string[]
): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  return (
    await transaction.reservation.updateMany({
      data: { reason: null },
      where: { id: { in: [...ids] }, reason: { not: null } }
    })
  ).count;
}

async function updateAdminActionDetails(
  transaction: Prisma.TransactionClient,
  ids: readonly string[]
): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  return (
    await transaction.adminAction.updateMany({
      data: { after: null, before: null, ipHash: null, reason: null },
      where: { id: { in: [...ids] } }
    })
  ).count;
}

async function updateSanctionReasons(
  transaction: Prisma.TransactionClient,
  ids: readonly string[]
): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  return (
    await transaction.userSanction.updateMany({
      data: { reason: RETENTION_EXPIRED_TEXT, revokedReason: null },
      where: { id: { in: [...ids] }, status: { not: "ACTIVE" } }
    })
  ).count;
}

async function updateAuditDetails(
  transaction: Prisma.TransactionClient,
  ids: readonly string[]
): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  return (
    await transaction.auditLog.updateMany({
      data: { detail: RETENTION_EXPIRED_TEXT },
      where: { id: { in: [...ids] } }
    })
  ).count;
}

function sortedIds(rows: readonly { readonly id: string }[]): readonly string[] {
  return rows.map((row) => row.id).sort();
}
