import { Prisma } from "@prisma/client";

import type { StudyPeriod } from "./study-periods";

export const DATABASE_ACTOR_ROLES = ["ADMIN", "STUDENT", "SYSTEM"] as const;

export type DatabaseActorRole = (typeof DATABASE_ACTOR_ROLES)[number];

export type DatabaseActor = {
  readonly id: string | null;
  readonly role: DatabaseActorRole;
};

export type DatabaseContextSetting = readonly [name: string, value: string];

export type DatabaseContextTransaction = {
  readonly $executeRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<unknown>;
};

export type DatabaseContextClient<TTransaction extends DatabaseContextTransaction, TOptions> = {
  readonly $transaction: <TResult>(
    operation: (transaction: TTransaction) => Promise<TResult>,
    options?: TOptions
  ) => Promise<TResult>;
};

type SessionUserActorInput = {
  readonly id: string;
  readonly role: string;
};

type WithDatabaseContextInput<TTransaction extends DatabaseContextTransaction, TOptions, TResult> = {
  readonly actor: DatabaseActor;
  readonly client: DatabaseContextClient<TTransaction, TOptions>;
  readonly operation: (transaction: TTransaction) => Promise<TResult>;
  readonly options?: TOptions;
};

type PrismaMutationTransactionOptions = {
  readonly isolationLevel: Prisma.TransactionIsolationLevel;
  readonly maxWait: number;
  readonly timeout: number;
};

type WithDatabaseMutationInput<TTransaction extends DatabaseContextTransaction, TResult> = {
  readonly actor: DatabaseActor;
  readonly client: DatabaseContextClient<TTransaction, PrismaMutationTransactionOptions>;
  readonly lockKeys: readonly string[];
  readonly operation: (transaction: TTransaction) => Promise<TResult>;
};

const SERIALIZABLE_RETRY_DELAYS_MS = [10, 25] as const;

export const PRISMA_MUTATION_TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 5_000,
  timeout: 10_000
} satisfies PrismaMutationTransactionOptions;

export const PRISMA_LOCKED_MUTATION_TRANSACTION_OPTIONS = {
  ...PRISMA_MUTATION_TRANSACTION_OPTIONS,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted
} satisfies PrismaMutationTransactionOptions;

export class TransactionRetryExhaustedError extends Error {
  public readonly attempts = SERIALIZABLE_RETRY_DELAYS_MS.length + 1;
  public readonly code = "TRANSACTION_RETRY_EXHAUSTED" as const;
  public override readonly cause: unknown;

  public constructor(cause: unknown) {
    super("Database transaction could not be completed after three attempts");
    this.cause = cause;
    this.name = "TransactionRetryExhaustedError";
  }
}

export function databaseActorFromSessionUser(user: SessionUserActorInput): DatabaseActor {
  return {
    id: user.id,
    role: user.role === "ADMIN" ? "ADMIN" : "STUDENT"
  };
}

export function systemDatabaseActor(): DatabaseActor {
  return {
    id: null,
    role: "SYSTEM"
  };
}

export function databaseContextSettings(actor: DatabaseActor): readonly DatabaseContextSetting[] {
  return [
    ["app.current_user_id", actor.id ?? ""],
    ["app.current_user_role", actor.role]
  ];
}

export async function setDatabaseContext(
  transaction: DatabaseContextTransaction,
  actor: DatabaseActor
): Promise<void> {
  for (const [name, value] of databaseContextSettings(actor)) {
    await transaction.$executeRaw`select set_config(${name}, ${value}, true)`;
  }
}

export async function withDatabaseContext<TTransaction extends DatabaseContextTransaction, TOptions, TResult>(
  input: WithDatabaseContextInput<TTransaction, TOptions, TResult>
): Promise<TResult> {
  return input.client.$transaction(async (transaction) => {
    await setDatabaseContext(transaction, input.actor);
    return input.operation(transaction);
  }, input.options);
}

export async function withDatabaseMutation<TTransaction extends DatabaseContextTransaction, TResult>(
  input: WithDatabaseMutationInput<TTransaction, TResult>
): Promise<TResult> {
  return retrySerializableMutationTransaction(() =>
    withDatabaseContext({
      actor: input.actor,
      client: input.client,
      operation: async (transaction) => {
        await acquireDatabaseMutationLocks(transaction, input.lockKeys);
        return input.operation(transaction);
      },
      options: PRISMA_MUTATION_TRANSACTION_OPTIONS
    })
  );
}

export async function retrySerializableMutationTransaction<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSerializableTransactionConflict(error)) {
        throw error;
      }
      const delay = SERIALIZABLE_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        throw new TransactionRetryExhaustedError(error);
      }
      await sleep(delay);
    }
  }
}

export function isSerializableTransactionConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001"))
  );
}

export function periodMutationLockKey(date: string, studyPeriod: StudyPeriod): string {
  return `period:${date}:${studyPeriod}`;
}

export function userMutationLockKey(userId: string): string {
  return `user:${userId}`;
}

export async function acquireDatabaseMutationLocks(
  transaction: DatabaseContextTransaction,
  lockKeys: readonly string[]
): Promise<void> {
  for (const lockKey of [...new Set(lockKeys)].sort()) {
    await transaction.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
  }
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
