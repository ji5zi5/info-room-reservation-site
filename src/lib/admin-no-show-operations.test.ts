import { Prisma, type PeriodSetting, type Reservation, type User } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  markAdministratorReservationNoShow,
  markAdministratorReservationNoShowInTransaction,
  type AdministratorNoShowInput,
  type AdministratorNoShowTransaction
} from "./admin-no-show-operations";
import { TransactionRetryExhaustedError } from "./db-context";
import type { DatabaseActor } from "./db-context";

type ScopedReadInput = {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: Pick<AdministratorNoShowTransaction, "reservation">) => Promise<unknown>;
};
type MutationInput = {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly lockKeys: readonly string[];
  readonly operation: (transaction: AdministratorNoShowTransaction) => Promise<unknown>;
};

const mocks = vi.hoisted(() => ({
  adminActionCreate: vi.fn(),
  auditLogCreate: vi.fn(),
  periodSettingFindMany: vi.fn(),
  reservationFindMany: vi.fn(),
  reservationFindUnique: vi.fn(),
  reservationUpdateMany: vi.fn(),
  userFindUnique: vi.fn(),
  userSanctionCreate: vi.fn(),
  userSanctionUpdateMany: vi.fn(),
  userUpdate: vi.fn(),
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
  createdAt: new Date("2026-06-15T00:00:00.000Z"),
  date: "2026-06-16",
  id: "reservation-1",
  reason: "자습",
  status: "CONFIRMED",
  studyPeriod: "EIGHTH",
  updatedAt: new Date("2026-06-15T00:00:00.000Z"),
  userId: "student-1"
};
const student: User = {
  anonymizedAt: null,
  bookingStatus: "ACTIVE",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  departedAt: null,
  generation: 31,
  id: reservation.userId,
  name: "학생",
  restrictionReason: null,
  restrictedUntil: null,
  riroId: "riro-student",
  role: "STUDENT",
  shadowBanProfile: "NORMAL",
  studentNumber: "10101",
  updatedAt: new Date("2026-01-01T00:00:00.000Z")
};
const input: AdministratorNoShowInput = {
  actor: { id: "admin-1", role: "ADMIN" },
  ipHash: "request-ip-hash",
  now: new Date("2026-06-16T07:20:00.000Z"),
  reason: "무단 미출석",
  reservationId: reservation.id
};

describe("administrator no-show operation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.reservationFindUnique.mockResolvedValue(reservation);
    mocks.userFindUnique.mockResolvedValue(student);
    mocks.periodSettingFindMany.mockResolvedValue([
      periodSetting("2026-06-16", "EIGHTH", "16:19"),
      periodSetting("__global__", "FIRST", "16:20")
    ]);
    mocks.reservationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.reservationFindMany.mockResolvedValue([]);
    mocks.userUpdate.mockResolvedValue({
      ...student,
      bookingStatus: "BANNED",
      restrictionReason: input.reason
    });
    mocks.adminActionCreate.mockResolvedValue({ id: "action-no-show" });
    mocks.userSanctionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.userSanctionCreate.mockResolvedValue({});
    mocks.auditLogCreate.mockResolvedValue({});
  });

  it("creates the permanent ban, replacement sanction, action, and audit once after close", async () => {
    // Given
    const transaction = transactionClient();

    // When
    const result = await markAdministratorReservationNoShowInTransaction(transaction, input);

    // Then
    expect(result).toMatchObject({
      cancelledFutureReservationCount: 0,
      kind: "ok",
      reservation: { id: reservation.id, status: "NO_SHOW" },
      user: { bookingStatus: "BANNED", id: student.id }
    });
    expect(mocks.reservationUpdateMany).toHaveBeenCalledWith({
      data: { status: "NO_SHOW" },
      where: { id: reservation.id, status: "CONFIRMED" }
    });
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      data: { bookingStatus: "BANNED", restrictedUntil: null, restrictionReason: input.reason },
      where: { id: student.id }
    });
    expect(mocks.userSanctionUpdateMany).toHaveBeenCalledOnce();
    expect(mocks.userSanctionCreate).toHaveBeenCalledOnce();
    expect(mocks.adminActionCreate).toHaveBeenCalledOnce();
    expect(mocks.auditLogCreate).toHaveBeenCalledOnce();
  });

  it.each(["CANCELLED", "NO_SHOW"])("returns invalid_status without writes for %s", async (status) => {
    // Given
    mocks.reservationFindUnique.mockResolvedValue({ ...reservation, status });

    // When
    const result = await markAdministratorReservationNoShowInTransaction(transactionClient(), input);

    // Then
    expect(result).toEqual({ kind: "invalid_status" });
    expectNoSideEffects();
  });

  it("returns admin_target without writes for an administrator reservation", async () => {
    // Given
    mocks.userFindUnique.mockResolvedValue({ ...student, role: "ADMIN" });

    // When
    const result = await markAdministratorReservationNoShowInTransaction(transactionClient(), input);

    // Then
    expect(result).toEqual({ kind: "admin_target" });
    expectNoSideEffects();
  });

  it("returns not_found without writes when the reservation user is missing", async () => {
    // Given
    mocks.userFindUnique.mockResolvedValue(null);

    // When
    const result = await markAdministratorReservationNoShowInTransaction(transactionClient(), input);

    // Then
    expect(result).toEqual({ kind: "not_found" });
    expectNoSideEffects();
  });

  it.each([
    ["missing settings", [], reservation, input.now],
    ["open target", [periodSetting("2026-06-16", "EIGHTH", "16:20")], reservation, input.now],
    [
      "future target",
      [periodSetting("2026-06-17", "EIGHTH", "16:19")],
      { ...reservation, date: "2026-06-17" },
      input.now
    ]
  ])("returns not_closed without writes for %s", async (_label, settings, targetReservation, now) => {
    // Given
    mocks.periodSettingFindMany.mockResolvedValue(settings);
    mocks.reservationFindUnique.mockResolvedValue(targetReservation);

    // When
    const result = await markAdministratorReservationNoShowInTransaction(transactionClient(), { ...input, now });

    // Then
    expect(result).toEqual({ kind: "not_closed" });
    expectNoSideEffects();
  });

  it("returns conflict without duplicate side effects when the confirmed CAS loses a race", async () => {
    // Given
    mocks.reservationUpdateMany.mockResolvedValue({ count: 0 });

    // When
    const result = await markAdministratorReservationNoShowInTransaction(transactionClient(), input);

    // Then
    expect(result).toEqual({ kind: "conflict" });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.adminActionCreate).not.toHaveBeenCalled();
    expect(mocks.userSanctionCreate).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("returns not_found before locking when the scoped reservation read misses", async () => {
    // Given
    mocks.withDatabaseContext.mockResolvedValue(null);

    // When
    const result = await markAdministratorReservationNoShow(input);

    // Then
    expect(result).toEqual({ kind: "not_found" });
    expect(mocks.withDatabaseMutation).not.toHaveBeenCalled();
  });

  it("uses the scoped admin read before taking the target user lock", async () => {
    // Given
    const transaction = transactionClient();
    mocks.withDatabaseContext.mockImplementation(async ({ operation }) => operation(transaction));
    mocks.withDatabaseMutation.mockImplementation(async ({ operation }) => operation(transaction));

    // When
    const result = await markAdministratorReservationNoShow(input);

    // Then
    expect(result).toMatchObject({ kind: "ok" });
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

  it("converts only exhausted serializable retries to the typed conflict outcome", async () => {
    // Given
    mocks.withDatabaseContext.mockResolvedValue({ userId: reservation.userId });
    mocks.withDatabaseMutation.mockRejectedValue(new TransactionRetryExhaustedError(serializableConflict()));

    // When
    const result = await markAdministratorReservationNoShow(input);

    // Then
    expect(result).toEqual({ kind: "conflict" });
  });
});

function transactionClient(): AdministratorNoShowTransaction {
  return {
    adminAction: { create: mocks.adminActionCreate },
    auditLog: { create: mocks.auditLogCreate },
    periodSetting: { findMany: mocks.periodSettingFindMany },
    reservation: {
      findMany: mocks.reservationFindMany,
      findUnique: mocks.reservationFindUnique,
      updateMany: mocks.reservationUpdateMany
    },
    user: { findUnique: mocks.userFindUnique, update: mocks.userUpdate },
    userSanction: { create: mocks.userSanctionCreate, updateMany: mocks.userSanctionUpdateMany }
  };
}

function periodSetting(date: string, studyPeriod: string, closeTime: string): PeriodSetting {
  return {
    capacity: 10,
    closeTime,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    date,
    enabled: true,
    id: `${date}:${studyPeriod}`,
    openTime: "13:00",
    studyPeriod,
    updatedAt: new Date("2026-01-01T00:00:00.000Z")
  };
}

function expectNoSideEffects(): void {
  expect(mocks.reservationUpdateMany).not.toHaveBeenCalled();
  expect(mocks.userUpdate).not.toHaveBeenCalled();
  expect(mocks.adminActionCreate).not.toHaveBeenCalled();
  expect(mocks.userSanctionCreate).not.toHaveBeenCalled();
  expect(mocks.auditLogCreate).not.toHaveBeenCalled();
}

function serializableConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("serialization conflict", {
    clientVersion: "test",
    code: "P2034"
  });
}
