import type { Prisma, User } from "@prisma/client";

import { selectCancellableConfirmedReservationIds } from "./admin-cancellable-reservations";
import { assertRestrictableUser } from "./admin-users";
import { prisma } from "./db";
import { toKstDate } from "./date";
import { userMutationLockKey, withDatabaseContext, withDatabaseMutation } from "./db-context";
import { periodSettingReadDates } from "./period-setting-values";
import { DEFAULT_SHADOW_BAN_PROFILE, type ShadowBanProfile } from "./shadow-ban-profile";

export type AdministratorSanctionActor = { readonly id: string; readonly role: "ADMIN" };
export type AdministratorSanctionStatus = "BANNED" | "RESTRICTED" | "SHADOW_BANNED";

export type AdministratorSanctionResult =
  | {
      readonly beforeStatus: string;
      readonly cancelledFutureReservationCount: number;
      readonly kind: "ok";
      readonly user: User;
    }
  | { readonly kind: "forbidden"; readonly reason: "admin_target" | "self_restriction" }
  | { readonly kind: "not_found" | "weaker_status" | "wrong_type" };

export async function applyAdministratorUserSanction(input: {
  readonly actor: AdministratorSanctionActor;
  readonly days: number | null;
  readonly ipHash: string;
  readonly now: Date;
  readonly profile: ShadowBanProfile;
  readonly reason: string;
  readonly status: AdministratorSanctionStatus;
  readonly studentNumber: string;
}): Promise<AdministratorSanctionResult> {
  const targetId = await findStudentId(input.actor, input.studentNumber);
  if (targetId === null) return { kind: "not_found" };
  const restrictedUntil = input.status === "RESTRICTED" && input.days !== null
    ? new Date(input.now.getTime() + input.days * 24 * 60 * 60_000)
    : null;
  return withDatabaseMutation({
    actor: input.actor,
    client: prisma,
    lockKeys: [userMutationLockKey(targetId)],
    operation: async (transaction) => {
      const target = await transaction.user.findUnique({ where: { id: targetId } });
      if (target === null) return { kind: "not_found" };
      const guard = assertRestrictableUser({ actorId: input.actor.id, target });
      if (guard.kind === "error") return { kind: "forbidden", reason: guard.reason };
      if (target.bookingStatus === "BANNED" && input.status !== "BANNED") return { kind: "weaker_status" };
      if (sameSanction(target, input, restrictedUntil)) {
        return { beforeStatus: target.bookingStatus, cancelledFutureReservationCount: 0, kind: "ok", user: target };
      }
      const updated = await transaction.user.update({
        data: {
          bookingStatus: input.status,
          restrictedUntil,
          restrictionReason: input.reason,
          shadowBanProfile: input.status === "SHADOW_BANNED" ? input.profile : DEFAULT_SHADOW_BAN_PROFILE
        },
        where: { id: targetId }
      });
      const cancelledFutureReservationCount = input.status === "BANNED"
        ? await cancelFutureReservations(transaction, targetId, input.now)
        : 0;
      const action = await transaction.adminAction.create({ data: {
        action: "USER_RESTRICTION_APPLY",
        actorId: input.actor.id,
        after: restrictionSnapshot(updated, cancelledFutureReservationCount),
        before: restrictionSnapshot(target, 0),
        ipHash: input.ipHash,
        reason: input.reason,
        targetUserId: targetId
      } });
      await transaction.userSanction.updateMany({
        data: { revokedAt: input.now, revokedById: input.actor.id, revokedReason: "새 관리자 제재로 대체", status: "REVOKED" },
        where: { status: "ACTIVE", userId: targetId }
      });
      await transaction.userSanction.create({ data: {
        actorId: input.actor.id,
        endsAt: restrictedUntil,
        reason: input.reason,
        sourceActionId: action.id,
        status: "ACTIVE",
        type: input.status === "RESTRICTED" ? "ADMIN_RESTRICTION" : "ADMIN_BAN",
        userId: targetId
      } });
      await transaction.auditLog.create({ data: {
        action: "USER_RESTRICTION_APPLY",
        actorId: input.actor.id,
        detail: JSON.stringify({ cancelledFutureReservationCount, days: input.days, profile: input.profile, reason: input.reason, status: input.status }),
        userId: targetId
      } });
      return { beforeStatus: target.bookingStatus, cancelledFutureReservationCount, kind: "ok", user: updated };
    }
  });
}

export async function removeAdministratorUserSanction(input: {
  readonly actor: AdministratorSanctionActor;
  readonly ipHash: string;
  readonly reason: string;
  readonly releaseType: "ALL" | "BAN" | "BLACKLIST" | "RESTRICTION";
  readonly studentNumber: string;
}): Promise<AdministratorSanctionResult> {
  const targetId = await findStudentId(input.actor, input.studentNumber);
  if (targetId === null) return { kind: "not_found" };
  return withDatabaseMutation({
    actor: input.actor,
    client: prisma,
    lockKeys: [userMutationLockKey(targetId)],
    operation: async (transaction) => {
      const target = await transaction.user.findUnique({ where: { id: targetId } });
      if (target === null) return { kind: "not_found" };
      const guard = assertRestrictableUser({ actorId: input.actor.id, target });
      if (guard.kind === "error") return { kind: "forbidden", reason: guard.reason };
      if (!matchesReleaseType(target.bookingStatus, input.releaseType)) return { kind: "wrong_type" };
      const updated = await transaction.user.update({
        data: { bookingStatus: "ACTIVE", restrictedUntil: null, restrictionReason: null, shadowBanProfile: DEFAULT_SHADOW_BAN_PROFILE },
        where: { id: targetId }
      });
      const action = await transaction.adminAction.create({ data: {
        action: "USER_RESTRICTION_REMOVE",
        actorId: input.actor.id,
        after: restrictionSnapshot(updated, 0),
        before: restrictionSnapshot(target, 0),
        ipHash: input.ipHash,
        reason: input.reason,
        targetUserId: targetId
      } });
      await transaction.userSanction.updateMany({
        data: { revokedAt: new Date(), revokedById: input.actor.id, revokedReason: input.reason, status: "REVOKED" },
        where: { status: "ACTIVE", userId: targetId }
      });
      await transaction.auditLog.create({ data: {
        action: "USER_RESTRICTION_REMOVE",
        actorId: input.actor.id,
        detail: JSON.stringify({ actionId: action.id, reason: input.reason, releaseType: input.releaseType }),
        userId: targetId
      } });
      return { beforeStatus: target.bookingStatus, cancelledFutureReservationCount: 0, kind: "ok", user: updated };
    }
  });
}

function findStudentId(actor: AdministratorSanctionActor, studentNumber: string): Promise<string | null> {
  return withDatabaseContext({
    actor,
    client: prisma,
    operation: async (transaction) => (await transaction.user.findUnique({ select: { id: true }, where: { studentNumber } }))?.id ?? null
  });
}

async function cancelFutureReservations(transaction: Prisma.TransactionClient, userId: string, now: Date): Promise<number> {
  const today = toKstDate(now);
  const candidates = await transaction.reservation.findMany({ where: { date: { gte: today }, status: "CONFIRMED", userId } });
  const settings = await transaction.periodSetting.findMany({ where: { date: { in: [...periodSettingReadDates(today)] } } });
  const ids = selectCancellableConfirmedReservationIds({ now, reservations: candidates, settings });
  return ids.length === 0 ? 0 : (await transaction.reservation.updateMany({ data: { status: "CANCELLED" }, where: { id: { in: [...ids] }, status: "CONFIRMED" } })).count;
}

function sameSanction(target: User, input: { readonly reason: string; readonly status: AdministratorSanctionStatus }, restrictedUntil: Date | null): boolean {
  return target.bookingStatus === input.status && target.restrictionReason === input.reason &&
    target.restrictedUntil?.getTime() === restrictedUntil?.getTime();
}

function matchesReleaseType(status: string, releaseType: "ALL" | "BAN" | "BLACKLIST" | "RESTRICTION"): boolean {
  return releaseType === "ALL" || (releaseType === "BAN" && status === "BANNED") ||
    (releaseType === "BLACKLIST" && status === "SHADOW_BANNED") ||
    (releaseType === "RESTRICTION" && status === "RESTRICTED");
}

function restrictionSnapshot(user: Pick<User, "bookingStatus" | "restrictedUntil" | "restrictionReason" | "shadowBanProfile">, cancelled: number): string {
  return JSON.stringify({ bookingStatus: user.bookingStatus, cancelledFutureReservationCount: cancelled, restrictedUntil: user.restrictedUntil, restrictionReason: user.restrictionReason, shadowBanProfile: user.shadowBanProfile });
}
