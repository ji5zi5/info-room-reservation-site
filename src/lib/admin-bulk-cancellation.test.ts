import type { Reservation } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdministratorCancellationInput, AdministratorCancellationResult } from "./admin-reservation-operations";
import { TransactionRetryExhaustedError } from "./db-context";

type ResolvedReservation = Pick<Reservation, "id" | "status" | "userId">;
type ReadTransaction = {
  readonly reservation: { readonly findMany: (input: unknown) => Promise<readonly ResolvedReservation[]> };
};

const mocks = vi.hoisted(() => ({
  cancel: vi.fn<(input: AdministratorCancellationInput) => Promise<AdministratorCancellationResult>>(),
  findMany: vi.fn<(input: unknown) => Promise<readonly ResolvedReservation[]>>(),
  withDatabaseContext: vi.fn<
    (input: { readonly operation: (transaction: ReadTransaction) => Promise<unknown> }) => Promise<unknown>
  >()
}));

vi.mock("./admin-reservation-operations", () => ({ cancelAdministratorReservation: mocks.cancel }));
vi.mock("./db", () => ({ prisma: { marker: "prisma-client" } }));
vi.mock("./db-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db-context")>();
  return { ...actual, withDatabaseContext: mocks.withDatabaseContext };
});

import { bulkCancelAdministratorReservations } from "./admin-bulk-cancellation";

const baseInput = {
  actor: { id: "admin-1", role: "ADMIN" },
  ipHash: "request-ip-hash",
  reason: "행사 준비로 정보실 사용 불가",
  reservationIds: ["reservation-c", "reservation-missing", "reservation-a", "reservation-b"],
  source: { kind: "WEB_ADMIN" }
} as const;
const rows: readonly ResolvedReservation[] = [
  { id: "reservation-a", status: "CONFIRMED", userId: "student-a" },
  { id: "reservation-b", status: "CANCELLED", userId: "student-a" },
  { id: "reservation-c", status: "CONFIRMED", userId: "student-c" }
];

describe("administrator bulk reservation cancellation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findMany.mockResolvedValue(rows);
    mocks.withDatabaseContext.mockImplementation(async ({ operation }) =>
      operation({ reservation: { findMany: mocks.findMany } })
    );
    mocks.cancel.mockResolvedValue({ kind: "invalid_status" });
  });

  it("predicts current outcomes in request order without cancellation or audit writes", async () => {
    // Given / When
    const result = await bulkCancelAdministratorReservations({ ...baseInput, mode: "preview" });

    // Then
    expect(result).toEqual({
      results: [
        { reservationId: "reservation-c", status: "cancelled" },
        { reservationId: "reservation-missing", status: "not_found" },
        { reservationId: "reservation-a", status: "cancelled" },
        { reservationId: "reservation-b", status: "invalid_status" }
      ],
      summary: { cancelled: 2, conflict: 0, invalidStatus: 1, notFound: 1, total: 4 }
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("executes shared cancellation in user and reservation lock order and returns request order", async () => {
    // Given
    mocks.cancel
      .mockResolvedValueOnce({ kind: "ok", reservation: cancelledReservation("reservation-a", "student-a") })
      .mockResolvedValueOnce({ kind: "invalid_status" })
      .mockResolvedValueOnce({ kind: "ok", reservation: cancelledReservation("reservation-c", "student-c") });

    // When
    const result = await bulkCancelAdministratorReservations({ ...baseInput, mode: "execute" });

    // Then
    expect(mocks.cancel.mock.calls.map(([input]) => input.reservationId)).toEqual([
      "reservation-a", "reservation-b", "reservation-c"
    ]);
    expect(result.results).toEqual([
      { reservationId: "reservation-c", status: "cancelled" },
      { reservationId: "reservation-missing", status: "not_found" },
      { reservationId: "reservation-a", status: "cancelled" },
      { reservationId: "reservation-b", status: "invalid_status" }
    ]);
    expect(result.summary).toEqual({ cancelled: 2, conflict: 0, invalidStatus: 1, notFound: 1, total: 4 });
    expect(mocks.cancel).toHaveBeenCalledTimes(3);
  });

  it("continues after one serializable conflict and reports truthful partial results", async () => {
    // Given
    mocks.cancel
      .mockRejectedValueOnce(serializableConflict())
      .mockResolvedValueOnce({ kind: "invalid_status" })
      .mockResolvedValueOnce({ kind: "ok", reservation: cancelledReservation("reservation-c", "student-c") });

    // When
    const result = await bulkCancelAdministratorReservations({ ...baseInput, mode: "execute" });

    // Then
    expect(result.results).toEqual([
      { reservationId: "reservation-c", status: "cancelled" },
      { reservationId: "reservation-missing", status: "not_found" },
      { reservationId: "reservation-a", status: "conflict" },
      { reservationId: "reservation-b", status: "invalid_status" }
    ]);
    expect(result.summary).toEqual({ cancelled: 1, conflict: 1, invalidStatus: 1, notFound: 1, total: 4 });
  });

  it("uses identical lock order for reversed input and leaves repeated terminal outcomes invalid", async () => {
    // Given / When
    await bulkCancelAdministratorReservations({ ...baseInput, mode: "execute" });
    const forwardOrder = mocks.cancel.mock.calls.map(([input]) => input.reservationId);
    mocks.cancel.mockClear();
    const result = await bulkCancelAdministratorReservations({
      ...baseInput,
      mode: "execute",
      reservationIds: [...baseInput.reservationIds].reverse()
    });

    // Then
    expect(mocks.cancel.mock.calls.map(([input]) => input.reservationId)).toEqual(forwardOrder);
    expect(result.summary).toEqual({ cancelled: 0, conflict: 0, invalidStatus: 3, notFound: 1, total: 4 });
  });
});

function cancelledReservation(id: string, userId: string): Reservation & { readonly status: "CANCELLED" } {
  return {
    createdAt: new Date("2026-08-11T00:00:00.000Z"), date: "2026-08-12", id, reason: "자습",
    status: "CANCELLED", studyPeriod: "EIGHTH", updatedAt: new Date("2026-08-11T00:00:00.000Z"), userId
  };
}

function serializableConflict(): TransactionRetryExhaustedError {
  return new TransactionRetryExhaustedError(new Prisma.PrismaClientKnownRequestError("write conflict", {
    clientVersion: "test", code: "P2034"
  }));
}
