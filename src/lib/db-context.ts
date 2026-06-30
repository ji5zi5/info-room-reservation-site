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
