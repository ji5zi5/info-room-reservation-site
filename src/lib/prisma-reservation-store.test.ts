import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  isSerializableTransactionConflict,
  PRISMA_RESERVATION_TRANSACTION_OPTIONS,
  retrySerializableReservationTransaction
} from "./prisma-reservation-store";

describe("Prisma reservation store transaction safety", () => {
  it("uses serializable isolation for capacity checks and reservation inserts", () => {
    expect(PRISMA_RESERVATION_TRANSACTION_OPTIONS).toMatchObject({
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 10_000
    });
  });

  it("retries serializable transaction conflicts before returning the result", async () => {
    let attempts = 0;

    const result = await retrySerializableReservationTransaction(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw prismaConflictError("P2034");
      }
      return "confirmed";
    });

    expect(result).toBe("confirmed");
    expect(attempts).toBe(3);
  });

  it("does not retry non-transaction Prisma errors", async () => {
    let attempts = 0;

    await expect(
      retrySerializableReservationTransaction(async () => {
        attempts += 1;
        throw prismaConflictError("P2002");
      })
    ).rejects.toMatchObject({ code: "P2002" });

    expect(attempts).toBe(1);
  });

  it("identifies only Prisma serializable write conflicts", () => {
    expect(isSerializableTransactionConflict(prismaConflictError("P2034"))).toBe(true);
    expect(isSerializableTransactionConflict(prismaConflictError("P2002"))).toBe(false);
    expect(isSerializableTransactionConflict(new Error("P2034"))).toBe(false);
  });
});

function prismaConflictError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Prisma write conflict", {
    clientVersion: "test",
    code
  });
}
