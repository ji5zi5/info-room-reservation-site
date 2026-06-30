import { describe, expect, it } from "vitest";

import {
  databaseActorFromSessionUser,
  databaseContextSettings,
  systemDatabaseActor,
  withDatabaseContext
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
});
