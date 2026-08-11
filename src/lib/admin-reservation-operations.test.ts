import type { Reservation } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelAdministratorReservation,
  cancelAdministratorReservationInTransaction,
  type AdministratorCancellationInput,
  type AdministratorCancellationTransaction
} from "./admin-reservation-operations";
import type { DatabaseActor } from "./db-context";

type ScopedReadInput = {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: Pick<AdministratorCancellationTransaction, "reservation">) => Promise<unknown>;
};
type MutationInput = {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly lockKeys: readonly string[];
  readonly operation: (transaction: AdministratorCancellationTransaction) => Promise<unknown>;
};

const mocks = vi.hoisted(() => ({
  adminActionCreate: vi.fn(),
  auditLogCreate: vi.fn(),
  reservationFindUnique: vi.fn(),
  reservationUpdateMany: vi.fn(),
  withDatabaseContext: vi.fn<(input: ScopedReadInput) => Promise<unknown>>(),
  withDatabaseMutation: vi.fn<(input: MutationInput) => Promise<unknown>>()
}));

vi.mock("./db", () => ({ prisma: { marker: "prisma-client" } }));
vi.mock("./db-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db-context")>();
  return {
    ...actual,
    withDatabaseContext: mocks.withDatabaseContext,
    withDatabaseMutation: mocks.withDatabaseMutation
  };
});

const reservation: Reservation = {
  createdAt: new Date("2026-08-11T00:00:00.000Z"),
  date: "2026-08-12",
  id: "reservation-1",
  reason: "자습",
  status: "CONFIRMED",
  studyPeriod: "EIGHTH",
  updatedAt: new Date("2026-08-11T00:00:00.000Z"),
  userId: "student-1"
};

const input: AdministratorCancellationInput = {
  actor: { id: "admin-1", role: "ADMIN" },
  ipHash: "request-ip-hash",
  reason: "행사 준비로 정보실 사용 불가",
  reservationId: reservation.id,
  source: { kind: "WEB_ADMIN" }
};

describe("administrator reservation cancellation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.reservationFindUnique.mockResolvedValue(reservation);
    mocks.reservationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.adminActionCreate.mockResolvedValue({ id: "action-cancel" });
    mocks.auditLogCreate.mockResolvedValue({});
  });

  it("creates one cancellation action and audit with the exact reason when the reservation is confirmed", async () => {
    // Given
    const transaction = transactionClient();

    // When
    const result = await cancelAdministratorReservationInTransaction(transaction, input);

    // Then
    expect(result).toEqual({ kind: "ok", reservation: { ...reservation, status: "CANCELLED" } });
    expect(mocks.reservationUpdateMany).toHaveBeenCalledWith({
      data: { status: "CANCELLED" },
      where: { id: reservation.id, status: "CONFIRMED" }
    });
    expect(mocks.adminActionCreate).toHaveBeenCalledOnce();
    expect(mocks.adminActionCreate).toHaveBeenCalledWith({
      data: {
        action: "ADMIN_RESERVATION_CANCEL",
        actorId: input.actor.id,
        after: JSON.stringify({ reservationStatus: "CANCELLED" }),
        before: JSON.stringify({ reservationStatus: "CONFIRMED" }),
        ipHash: input.ipHash,
        reason: input.reason,
        reservationId: reservation.id,
        targetUserId: reservation.userId
      }
    });
    expect(mocks.auditLogCreate).toHaveBeenCalledOnce();
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: {
        action: "ADMIN_RESERVATION_CANCEL",
        actorId: input.actor.id,
        detail: JSON.stringify({
          actionId: "action-cancel",
          reason: input.reason,
          reservationId: reservation.id
        }),
        userId: reservation.userId
      }
    });
    expect(mocks.withDatabaseContext).not.toHaveBeenCalled();
    expect(mocks.withDatabaseMutation).not.toHaveBeenCalled();
  });

  it("returns invalid_status without writing when the reservation is already terminal", async () => {
    // Given
    mocks.reservationFindUnique.mockResolvedValue({ ...reservation, status: "NO_SHOW" });

    // When
    const result = await cancelAdministratorReservationInTransaction(transactionClient(), input);

    // Then
    expect(result).toEqual({ kind: "invalid_status" });
    expect(mocks.reservationUpdateMany).not.toHaveBeenCalled();
    expect(mocks.adminActionCreate).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("returns not_found without writing when the reservation does not exist", async () => {
    // Given
    mocks.reservationFindUnique.mockResolvedValue(null);

    // When
    const result = await cancelAdministratorReservationInTransaction(transactionClient(), input);

    // Then
    expect(result).toEqual({ kind: "not_found" });
    expect(mocks.reservationUpdateMany).not.toHaveBeenCalled();
    expect(mocks.adminActionCreate).not.toHaveBeenCalled();
  });

  it("returns invalid_status without duplicate audit writes when the confirmed guard loses a race", async () => {
    // Given
    mocks.reservationUpdateMany.mockResolvedValue({ count: 0 });

    // When
    const result = await cancelAdministratorReservationInTransaction(transactionClient(), input);

    // Then
    expect(result).toEqual({ kind: "invalid_status" });
    expect(mocks.adminActionCreate).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("records one mutation, action, and audit when two cancellation primitives race on the confirmed guard", async () => {
    // Given
    mocks.reservationUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    // When
    const results = await Promise.all([
      cancelAdministratorReservationInTransaction(transactionClient(), input),
      cancelAdministratorReservationInTransaction(transactionClient(), input)
    ]);

    // Then
    expect(results.map(({ kind }) => kind).sort()).toEqual(["invalid_status", "ok"]);
    expect(mocks.reservationUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.adminActionCreate).toHaveBeenCalledOnce();
    expect(mocks.auditLogCreate).toHaveBeenCalledOnce();
  });

  it("performs the scoped read as the local admin before locking the reservation user", async () => {
    // Given
    const transaction = transactionClient();
    mocks.withDatabaseContext.mockImplementation(async ({ operation }) => operation(transaction));
    mocks.withDatabaseMutation.mockImplementation(async ({ operation }) => operation(transaction));

    // When
    const result = await cancelAdministratorReservation(input);

    // Then
    expect(result).toMatchObject({ kind: "ok" });
    expect(mocks.withDatabaseContext).toHaveBeenCalledWith({
      actor: input.actor,
      client: expect.anything(),
      operation: expect.any(Function)
    });
    expect(mocks.reservationFindUnique).toHaveBeenNthCalledWith(1, {
      select: { userId: true },
      where: { id: reservation.id }
    });
    expect(mocks.withDatabaseMutation).toHaveBeenCalledWith({
      actor: input.actor,
      client: expect.anything(),
      lockKeys: [`user:${reservation.userId}`],
      operation: expect.any(Function)
    });
    expect(mocks.withDatabaseContext.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.withDatabaseMutation.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });
});

function transactionClient(): AdministratorCancellationTransaction {
  return {
    adminAction: { create: mocks.adminActionCreate },
    auditLog: { create: mocks.auditLogCreate },
    reservation: {
      findUnique: mocks.reservationFindUnique,
      updateMany: mocks.reservationUpdateMany
    }
  };
}
