import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  databaseActorFromSessionUser,
  databaseContextSettings,
  PRISMA_MUTATION_TRANSACTION_OPTIONS,
  retrySerializableMutationTransaction,
  systemDatabaseActor,
  TransactionRetryExhaustedError,
  withDatabaseContext,
  withDatabaseMutation
} from "./db-context";

type RecordedRawCall = {
  readonly strings: readonly string[];
  readonly values: readonly unknown[];
};

class FakeTransaction {
  public readonly rawCalls: RecordedRawCall[] = [];

  public async $executeRaw(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<number> {
    this.rawCalls.push({ strings: [...strings], values });
    return 1;
  }
}

class FakePrismaClient {
  public readonly transaction = new FakeTransaction();
  public readonly transactionOptions: unknown[] = [];

  public async $transaction<T>(operation: (transaction: FakeTransaction) => Promise<T>, options?: unknown): Promise<T> {
    this.transactionOptions.push(options);
    return operation(this.transaction);
  }
}

describe("database RLS context", () => {
  it("builds actor settings for student, admin, and system contexts", () => {
    const studentActor = databaseActorFromSessionUser({ id: "user-student", role: "STUDENT" });
    const adminActor = databaseActorFromSessionUser({ id: "user-admin", role: "ADMIN" });
    const systemActor = systemDatabaseActor();

    expect(databaseContextSettings(studentActor)).toEqual([
      ["app.current_user_id", "user-student"],
      ["app.current_user_role", "STUDENT"]
    ]);
    expect(databaseContextSettings(adminActor)).toEqual([
      ["app.current_user_id", "user-admin"],
      ["app.current_user_role", "ADMIN"]
    ]);
    expect(databaseContextSettings(systemActor)).toEqual([
      ["app.current_user_id", ""],
      ["app.current_user_role", "SYSTEM"]
    ]);
  });

  it("sets the actor context inside the same transaction before running application queries", async () => {
    const client = new FakePrismaClient();
    const actor = databaseActorFromSessionUser({ id: "user-1", role: "STUDENT" });
    const options = { isolationLevel: "Serializable", timeout: 1_000 } as const;

    const result = await withDatabaseContext({
      actor,
      client,
      operation: async (transaction) => {
        expect(transaction.rawCalls).toHaveLength(2);
        return "reserved";
      },
      options
    });

    expect(result).toBe("reserved");
    expect(client.transactionOptions).toEqual([options]);
    expect(client.transaction.rawCalls).toEqual([
      {
        strings: ["select set_config(", ", ", ", true)"],
        values: ["app.current_user_id", "user-1"]
      },
      {
        strings: ["select set_config(", ", ", ", true)"],
        values: ["app.current_user_role", "STUDENT"]
      }
    ]);
  });

  it("retries three serializable conflicts and exposes the final P2034 as the exhausted cause", async () => {
    // Given
    const conflict = serializableConflict();
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(conflict);

    // When
    const result = retrySerializableMutationTransaction(operation);

    // Then
    await expect(result).rejects.toMatchObject({
      attempts: 3,
      cause: conflict,
      code: "TRANSACTION_RETRY_EXHAUSTED"
    } satisfies Partial<TransactionRetryExhaustedError>);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("retries P2010 raw-query serialization failures identified by PostgreSQL SQLSTATE metadata", async () => {
    // Given
    const conflict = rawQueryFailure({
      message: "Raw query failed. Code: `40001`. Message: `could not serialize access due to concurrent update`",
      meta: { code: "40001" }
    });
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(conflict);

    // When
    const result = retrySerializableMutationTransaction(operation);

    // Then
    await expect(result).rejects.toMatchObject({
      attempts: 3,
      cause: conflict,
      code: "TRANSACTION_RETRY_EXHAUSTED"
    } satisfies Partial<TransactionRetryExhaustedError>);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry an unrelated P2010 raw-query failure", async () => {
    // Given
    const failure = rawQueryFailure({
      message: "Raw query failed. Code: `42501`. Message: `permission denied`",
      meta: { code: "42501" }
    });
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    // When
    const result = retrySerializableMutationTransaction(operation);

    // Then
    await expect(result).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not retry a P2010 with a serialization lookalike only in its message", async () => {
    // Given
    const failure = rawQueryFailure({
      message: "Raw query failed. Code: `40001`. Message: `could not serialize access`"
    });
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    // When
    const result = retrySerializableMutationTransaction(operation);

    // Then
    await expect(result).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not retry an unknown or non-serializable database failure", async () => {
    // Given
    const failure = new Error("connection lost");
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    // When
    const result = retrySerializableMutationTransaction(operation);

    // Then
    await expect(result).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("sets context, acquires sorted deduplicated advisory locks, then runs the operation in Serializable", async () => {
    // Given
    const client = new FakePrismaClient();
    const events: string[] = [];
    const originalExecuteRaw = client.transaction.$executeRaw.bind(client.transaction);
    client.transaction.$executeRaw = async (strings, ...values) => {
      const sql = strings.join("?");
      events.push(sql.includes("pg_advisory_xact_lock") ? `lock:${String(values[0])}` : `context:${String(values[0])}`);
      return originalExecuteRaw(strings, ...values);
    };

    // When
    const result = await withDatabaseMutation({
      actor: databaseActorFromSessionUser({ id: "admin-1", role: "ADMIN" }),
      client,
      lockKeys: ["user:z", "user:a", "user:z"],
      operation: async () => {
        events.push("operation");
        return "mutated";
      }
    });

    // Then
    expect(result).toBe("mutated");
    expect(client.transactionOptions).toEqual([PRISMA_MUTATION_TRANSACTION_OPTIONS]);
    expect(events).toEqual([
      "context:app.current_user_id",
      "context:app.current_user_role",
      "lock:user:a",
      "lock:user:z",
      "operation"
    ]);
    expect(client.transaction.rawCalls.slice(2)).toEqual([
      {
        strings: ["select pg_advisory_xact_lock(hashtextextended(", ", 0))"],
        values: ["user:a"]
      },
      {
        strings: ["select pg_advisory_xact_lock(hashtextextended(", ", 0))"],
        values: ["user:z"]
      }
    ]);
  });
});

function serializableConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("serialization conflict", {
    clientVersion: "test",
    code: "P2034"
  });
}

function rawQueryFailure(input: { readonly message: string; readonly meta?: Record<string, unknown> }): Prisma.PrismaClientKnownRequestError {
  if (input.meta === undefined) {
    return new Prisma.PrismaClientKnownRequestError(input.message, {
      clientVersion: "test",
      code: "P2010"
    });
  }

  return new Prisma.PrismaClientKnownRequestError(input.message, {
    clientVersion: "test",
    code: "P2010",
    meta: input.meta
  });
}
