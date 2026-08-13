import type { AdminAction, PeriodSetting, Prisma, Reservation, User } from "@prisma/client";

import { selectCancellableConfirmedReservationIds } from "./admin-cancellable-reservations";
import { canMarkReservationNoShow } from "./admin-reservation-transition";
import { prisma } from "./db";
import {
  isSerializableTransactionConflict,
  TransactionRetryExhaustedError,
  userMutationLockKey,
  withDatabaseContext,
  withDatabaseMutation
} from "./db-context";
import { toKstDate } from "./date";
import { getPeriodWindowState } from "./period-window";
import { GLOBAL_PERIOD_SETTINGS_DATE, periodSettingReadDates } from "./period-setting-values";
import { buildNoShowBan } from "./reservation-service";

export type AdministratorNoShowActor = {
  readonly id: string;
  readonly role: "ADMIN";
};

export type AdministratorNoShowInput = {
  readonly actor: AdministratorNoShowActor;
  readonly ipHash: string;
  readonly now: Date;
  readonly reason: string;
  readonly reservationId: string;
};

export type AdministratorNoShowResult =
  | { readonly kind: "admin_target" }
  | { readonly kind: "conflict" }
  | { readonly kind: "invalid_status" }
  | { readonly kind: "not_closed" }
  | { readonly kind: "not_found" }
  | {
      readonly cancelledFutureReservationCount: number;
      readonly kind: "ok";
      readonly reservation: Reservation & { readonly status: "NO_SHOW" };
      readonly user: User;
    };

export type AdministratorNoShowTransaction = {
  readonly adminAction: {
    readonly create: (input: Prisma.AdminActionCreateArgs) => Promise<Pick<AdminAction, "id">>;
  };
  readonly auditLog: { readonly create: (input: Prisma.AuditLogCreateArgs) => Promise<unknown> };
  readonly periodSetting: {
    readonly findMany: (input: Prisma.PeriodSettingFindManyArgs) => Promise<readonly PeriodSetting[]>;
  };
  readonly reservation: {
    readonly findMany: (input: Prisma.ReservationFindManyArgs) => Promise<readonly Reservation[]>;
    readonly findUnique: (input: { readonly where: { readonly id: string } }) => Promise<Reservation | null>;
    readonly updateMany: (input: Prisma.ReservationUpdateManyArgs) => Promise<Prisma.BatchPayload>;
  };
  readonly user: {
    readonly findUnique: (input: { readonly where: { readonly id: string } }) => Promise<User | null>;
    readonly update: (input: Prisma.UserUpdateArgs) => Promise<User>;
  };
  readonly userSanction: {
    readonly create: (input: Prisma.UserSanctionCreateArgs) => Promise<unknown>;
    readonly updateMany: (input: Prisma.UserSanctionUpdateManyArgs) => Promise<unknown>;
  };
};

export async function markAdministratorReservationNoShow(
  input: AdministratorNoShowInput
): Promise<AdministratorNoShowResult> {
  const target = await withDatabaseContext({
    actor: input.actor,
    client: prisma,
    operation: (transaction) => transaction.reservation.findUnique({
      select: { userId: true },
      where: { id: input.reservationId }
    })
  });
  if (!target) {
    return { kind: "not_found" };
  }

  try {
    return await withDatabaseMutation({
      actor: input.actor,
      client: prisma,
      lockKeys: [userMutationLockKey(target.userId)],
      operation: (transaction) => markAdministratorReservationNoShowInTransaction(transaction, input)
    });
  } catch (error) {
    if (error instanceof TransactionRetryExhaustedError && isSerializableTransactionConflict(error.cause)) {
      return { kind: "conflict" };
    }
    throw error;
  }
}

export async function markAdministratorReservationNoShowInTransaction(
  transaction: AdministratorNoShowTransaction,
  input: AdministratorNoShowInput
): Promise<AdministratorNoShowResult> {
  const reservation = await transaction.reservation.findUnique({ where: { id: input.reservationId } });
  if (!reservation) {
    return { kind: "not_found" };
  }
  if (reservation.status !== "CONFIRMED") {
    return { kind: "invalid_status" };
  }

  const target = await transaction.user.findUnique({ where: { id: reservation.userId } });
  if (!target) {
    return { kind: "not_found" };
  }
  if (target.role === "ADMIN") {
    return { kind: "admin_target" };
  }

  const targetSettings = await transaction.periodSetting.findMany({
    where: {
      date: { in: [...periodSettingReadDates(reservation.date)] },
      studyPeriod: reservation.studyPeriod
    }
  });
  const effectiveSetting = findEffectiveSetting(reservation, targetSettings);
  if (!effectiveSetting) {
    return { kind: "not_closed" };
  }
  if (reservation.date > toKstDate(input.now)) {
    return { kind: "not_closed" };
  }
  const windowState = getPeriodWindowState(
    { closeTime: effectiveSetting.closeTime, date: reservation.date, openTime: effectiveSetting.openTime },
    input.now
  );
  if (!canMarkReservationNoShow(reservation.status, windowState)) {
    return { kind: "not_closed" };
  }

  const transition = await transaction.reservation.updateMany({
    data: { status: "NO_SHOW" },
    where: { id: reservation.id, status: "CONFIRMED" }
  });
  if (transition.count !== 1) {
    return { kind: "conflict" };
  }

  const updatedReservation = { ...reservation, status: "NO_SHOW" } as const;
  const today = toKstDate(input.now);
  const candidates = await transaction.reservation.findMany({
    where: {
      date: { gte: today },
      id: { not: reservation.id },
      status: "CONFIRMED",
      userId: reservation.userId
    }
  });
  const settings = await transaction.periodSetting.findMany({
    where: { date: { in: [...periodSettingReadDates(today)] } }
  });
  const cancellableReservationIds = selectCancellableConfirmedReservationIds({
    now: input.now,
    reservations: candidates,
    settings
  });
  const cancelledFutureReservationCount =
    cancellableReservationIds.length === 0
      ? 0
      : (
          await transaction.reservation.updateMany({
            data: { status: "CANCELLED" },
            where: { id: { in: [...cancellableReservationIds] }, status: "CONFIRMED" }
          })
        ).count;
  const restriction = buildNoShowBan(input.reason);
  const user = await transaction.user.update({ data: restriction, where: { id: reservation.userId } });
  const action = await transaction.adminAction.create({
    data: {
      action: "NO_SHOW_BAN",
      actorId: input.actor.id,
      after: JSON.stringify({
        bookingStatus: user.bookingStatus,
        cancelledFutureReservationCount,
        reservationStatus: updatedReservation.status,
        restrictionReason: user.restrictionReason,
        restrictedUntil: user.restrictedUntil
      }),
      before: JSON.stringify({
        bookingStatus: target.bookingStatus,
        reservationStatus: reservation.status,
        restrictionReason: target.restrictionReason,
        restrictedUntil: target.restrictedUntil
      }),
      ipHash: input.ipHash,
      reason: input.reason,
      reservationId: reservation.id,
      targetUserId: user.id
    }
  });
  await transaction.userSanction.updateMany({
    data: {
      revokedAt: new Date(),
      revokedById: input.actor.id,
      revokedReason: "노쇼 제재로 대체",
      status: "REVOKED"
    },
    where: { status: "ACTIVE", userId: user.id }
  });
  await transaction.userSanction.create({
    data: {
      actorId: input.actor.id,
      endsAt: null,
      reason: input.reason,
      sourceActionId: action.id,
      status: "ACTIVE",
      type: "NO_SHOW_BAN",
      userId: user.id
    }
  });
  await transaction.auditLog.create({
    data: {
      action: "NO_SHOW_BAN",
      actorId: input.actor.id,
      detail: JSON.stringify({
        actionId: action.id,
        cancelledFutureReservationCount,
        reason: input.reason,
        reservationId: reservation.id
      }),
      userId: user.id
    }
  });
  return { cancelledFutureReservationCount, kind: "ok", reservation: updatedReservation, user };
}

function findEffectiveSetting(
  reservation: Reservation,
  settings: readonly PeriodSetting[]
): PeriodSetting | undefined {
  return (
    settings.find(
      (setting) => setting.date === reservation.date && setting.studyPeriod === reservation.studyPeriod
    ) ??
    settings.find(
      (setting) =>
        setting.date === GLOBAL_PERIOD_SETTINGS_DATE && setting.studyPeriod === reservation.studyPeriod
    )
  );
}
