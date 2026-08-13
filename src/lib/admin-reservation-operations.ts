import type { AdminAction, Prisma, Reservation } from "@prisma/client";

import { canAdminCancelReservation } from "./admin-reservation-transition";
import { prisma } from "./db";
import { userMutationLockKey, withDatabaseContext, withDatabaseMutation } from "./db-context";

export type AdministratorCancellationActor = {
  readonly id: string;
  readonly role: "ADMIN";
};

export type AdministratorCancellationSource =
  | { readonly kind: "DISCORD_ADMIN_CANCEL" }
  | { readonly kind: "DISCORD_REJECTION" }
  | { readonly kind: "WEB_ADMIN" };

export type AdministratorCancellationInput = {
  readonly actor: AdministratorCancellationActor;
  readonly ipHash: string;
  readonly reason: string;
  readonly reservationId: string;
  readonly source: AdministratorCancellationSource;
};

export type AdministratorCancellationResult =
  | { readonly kind: "invalid_status" }
  | { readonly kind: "not_found" }
  | { readonly kind: "ok"; readonly reservation: Reservation & { readonly status: "CANCELLED" } };

export type AdministratorCancellationTransaction = {
  readonly adminAction: {
    readonly create: (input: Prisma.AdminActionCreateArgs) => Promise<Pick<AdminAction, "id">>;
  };
  readonly auditLog: {
    readonly create: (input: Prisma.AuditLogCreateArgs) => Promise<unknown>;
  };
  readonly reservation: {
    readonly findUnique: (input: { readonly where: { readonly id: string } }) => Promise<Reservation | null>;
    readonly updateMany: (input: Prisma.ReservationUpdateManyArgs) => Promise<Prisma.BatchPayload>;
  };
};

export async function cancelAdministratorReservation(
  input: AdministratorCancellationInput
): Promise<AdministratorCancellationResult> {
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

  return withDatabaseMutation({
    actor: input.actor,
    client: prisma,
    lockKeys: [userMutationLockKey(target.userId)],
    operation: (transaction) => cancelAdministratorReservationInTransaction(transaction, input)
  });
}

export async function cancelAdministratorReservationInTransaction(
  transaction: AdministratorCancellationTransaction,
  input: AdministratorCancellationInput
): Promise<AdministratorCancellationResult> {
  const reservation = await transaction.reservation.findUnique({ where: { id: input.reservationId } });
  if (!reservation) {
    return { kind: "not_found" };
  }
  if (!canAdminCancelReservation(reservation.status)) {
    return { kind: "invalid_status" };
  }

  const transition = await transaction.reservation.updateMany({
    data: { status: "CANCELLED" },
    where: { id: reservation.id, status: "CONFIRMED" }
  });
  if (transition.count !== 1) {
    return { kind: "invalid_status" };
  }

  const updated = { ...reservation, status: "CANCELLED" } as const;
  const action = await transaction.adminAction.create({
    data: {
      action: "ADMIN_RESERVATION_CANCEL",
      actorId: input.actor.id,
      after: JSON.stringify({ reservationStatus: updated.status }),
      before: JSON.stringify({ reservationStatus: reservation.status }),
      ipHash: input.ipHash,
      reason: input.reason,
      reservationId: reservation.id,
      targetUserId: reservation.userId
    }
  });
  await transaction.auditLog.create({
    data: {
      action: "ADMIN_RESERVATION_CANCEL",
      actorId: input.actor.id,
      detail: JSON.stringify({
        actionId: action.id,
        reason: input.reason,
        reservationId: reservation.id,
        source: input.source.kind
      }),
      userId: reservation.userId
    }
  });
  return { kind: "ok", reservation: updated };
}
