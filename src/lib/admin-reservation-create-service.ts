import { Prisma, type Reservation } from "@prisma/client";

import { isReservableDate } from "./advance-reservation-policy";
import { prisma } from "./db";
import {
  periodMutationLockKey,
  userMutationLockKey,
  withDatabaseContext,
  withDatabaseMutation
} from "./db-context";
import { getPeriodWindowState } from "./period-window";
import { periodSettingReadDates, resolveEffectivePeriodSetting } from "./period-setting-values";
import type { StudyPeriod } from "./study-periods";

export type AdministratorReservationCreateInput = {
  readonly actor: { readonly id: string; readonly role: "ADMIN" };
  readonly date: string;
  readonly ipHash: string;
  readonly now: Date;
  readonly reason: string;
  readonly studentNumber: string;
  readonly studyPeriod: StudyPeriod;
};

export type AdministratorReservationCreateResult =
  | { readonly kind: "confirmed"; readonly reservation: Reservation; readonly studentName: string }
  | {
      readonly kind:
        | "admin_target"
        | "advance_unavailable"
        | "cancelled_same_slot"
        | "closed"
        | "disabled"
        | "duplicate"
        | "full"
        | "not_found"
        | "not_open_yet"
        | "restricted"
        | "shadow_banned";
    };

export async function createAdministratorReservation(
  input: AdministratorReservationCreateInput
): Promise<AdministratorReservationCreateResult> {
  const targetIdentity = await withDatabaseContext({
    actor: input.actor,
    client: prisma,
    operation: (transaction) => transaction.user.findUnique({
      select: { id: true, role: true },
      where: { studentNumber: input.studentNumber }
    })
  });
  if (targetIdentity === null) return { kind: "not_found" };
  if (targetIdentity.role === "ADMIN") return { kind: "admin_target" };

  try {
    return await withDatabaseMutation({
      actor: input.actor,
      client: prisma,
      lockKeys: [periodMutationLockKey(input.date, input.studyPeriod), userMutationLockKey(targetIdentity.id)],
      operation: async (transaction) => {
        const target = await transaction.user.findUnique({ where: { id: targetIdentity.id } });
        if (target === null) return { kind: "not_found" };
        if (target.role === "ADMIN") return { kind: "admin_target" };
        const statusError = bookingStatusError(target.bookingStatus, target.restrictedUntil, input.now);
        if (statusError !== null) return { kind: statusError };
        if (!isReservableDate(input.date, input.now)) return { kind: "advance_unavailable" };
        const setting = resolveEffectivePeriodSetting(
          input.date,
          input.studyPeriod,
          await transaction.periodSetting.findMany({
            where: { date: { in: [...periodSettingReadDates(input.date)] }, studyPeriod: input.studyPeriod }
          })
        );
        if (!setting.enabled) return { kind: "disabled" };
        const windowState = getPeriodWindowState(setting, input.now);
        if (windowState !== "open") return { kind: windowState };
        const existing = await transaction.reservation.findUnique({
          where: {
            userId_date_studyPeriod: {
              date: input.date,
              studyPeriod: input.studyPeriod,
              userId: target.id
            }
          }
        });
        if (existing !== null) return { kind: existing.status === "CONFIRMED" ? "duplicate" : "cancelled_same_slot" };
        const confirmedCount = await transaction.reservation.count({
          where: { date: input.date, status: "CONFIRMED", studyPeriod: input.studyPeriod }
        });
        if (confirmedCount >= setting.capacity) return { kind: "full" };
        const reservation = await transaction.reservation.create({
          data: {
            date: input.date,
            reason: input.reason,
            status: "CONFIRMED",
            studyPeriod: input.studyPeriod,
            userId: target.id
          }
        });
        const action = await transaction.adminAction.create({ data: {
          action: "ADMIN_RESERVATION_CREATE",
          actorId: input.actor.id,
          after: JSON.stringify({ date: reservation.date, reservationStatus: reservation.status, studyPeriod: reservation.studyPeriod }),
          before: null,
          ipHash: input.ipHash,
          reason: input.reason,
          reservationId: reservation.id,
          targetUserId: target.id
        } });
        await transaction.auditLog.create({ data: {
          action: "ADMIN_RESERVATION_CREATE",
          actorId: input.actor.id,
          detail: JSON.stringify({ actionId: action.id, date: reservation.date, reason: input.reason, reservationId: reservation.id, studyPeriod: reservation.studyPeriod }),
          userId: target.id
        } });
        return { kind: "confirmed", reservation, studentName: target.name };
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { kind: "duplicate" };
    throw error;
  }
}

function bookingStatusError(
  bookingStatus: string,
  restrictedUntil: Date | null,
  now: Date
): "restricted" | "shadow_banned" | null {
  switch (bookingStatus) {
    case "ACTIVE": return null;
    case "SHADOW_BANNED": return "shadow_banned";
    case "BANNED": return "restricted";
    case "RESTRICTED": return restrictedUntil === null || restrictedUntil.getTime() > now.getTime() ? "restricted" : null;
    default: return "restricted";
  }
}
