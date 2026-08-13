import type { Reservation } from "@prisma/client";

import {
  cancelAdministratorReservation,
  type AdministratorCancellationActor,
  type AdministratorCancellationSource
} from "./admin-reservation-operations";
import { prisma } from "./db";
import {
  isSerializableTransactionConflict,
  TransactionRetryExhaustedError,
  withDatabaseContext
} from "./db-context";

export type AdministratorBulkCancellationInput = {
  readonly actor: AdministratorCancellationActor;
  readonly ipHash: string;
  readonly mode: "execute" | "preview";
  readonly reason: string;
  readonly reservationIds: readonly string[];
  readonly source: AdministratorCancellationSource;
};

export type AdministratorBulkCancellationStatus = "cancelled" | "conflict" | "invalid_status" | "not_found";

export type AdministratorBulkCancellationResult = {
  readonly results: readonly {
    readonly reservationId: string;
    readonly status: AdministratorBulkCancellationStatus;
  }[];
  readonly summary: {
    readonly cancelled: number;
    readonly conflict: number;
    readonly invalidStatus: number;
    readonly notFound: number;
    readonly total: number;
  };
};

export async function bulkCancelAdministratorReservations(
  input: AdministratorBulkCancellationInput
): Promise<AdministratorBulkCancellationResult> {
  const resolved = await withDatabaseContext({
    actor: input.actor,
    client: prisma,
    operation: (transaction) => transaction.reservation.findMany({
      select: { id: true, status: true, userId: true },
      where: { id: { in: [...input.reservationIds] } }
    })
  });
  const targetsById = new Map(resolved.map((reservation) => [reservation.id, reservation]));

  if (input.mode === "preview") {
    return buildResult(input.reservationIds.map((reservationId) => ({
      reservationId,
      status: previewStatus(targetsById.get(reservationId))
    })));
  }

  const sortedTargets = [...resolved].sort(compareResolvedReservations);
  const statuses = new Map<string, AdministratorBulkCancellationStatus>();
  for (const target of sortedTargets) {
    statuses.set(target.id, await executeCancellation(input, target.id));
  }

  return buildResult(input.reservationIds.map((reservationId) => ({
    reservationId,
    status: statuses.get(reservationId) ?? "not_found"
  })));
}

type ResolvedReservation = Pick<Reservation, "id" | "status" | "userId">;
type ItemResult = AdministratorBulkCancellationResult["results"][number];

function previewStatus(target: ResolvedReservation | undefined): AdministratorBulkCancellationStatus {
  if (!target) {
    return "not_found";
  }
  return target.status === "CONFIRMED" ? "cancelled" : "invalid_status";
}

async function executeCancellation(
  input: AdministratorBulkCancellationInput,
  reservationId: string
): Promise<AdministratorBulkCancellationStatus> {
  try {
    const result = await cancelAdministratorReservation({
      actor: input.actor,
      ipHash: input.ipHash,
      reason: input.reason,
      reservationId,
      source: input.source
    });
    switch (result.kind) {
      case "ok": return "cancelled";
      case "invalid_status": return "invalid_status";
      case "not_found": return "not_found";
    }
  } catch (error) {
    if (error instanceof TransactionRetryExhaustedError && isSerializableTransactionConflict(error.cause)) {
      return "conflict";
    }
    throw error;
  }
}

function compareResolvedReservations(left: ResolvedReservation, right: ResolvedReservation): number {
  if (left.userId !== right.userId) {
    return left.userId < right.userId ? -1 : 1;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

function buildResult(results: readonly ItemResult[]): AdministratorBulkCancellationResult {
  const summary = { cancelled: 0, conflict: 0, invalidStatus: 0, notFound: 0, total: results.length };
  for (const result of results) {
    switch (result.status) {
      case "cancelled": summary.cancelled += 1; break;
      case "conflict": summary.conflict += 1; break;
      case "invalid_status": summary.invalidStatus += 1; break;
      case "not_found": summary.notFound += 1; break;
    }
  }
  return { results, summary };
}
