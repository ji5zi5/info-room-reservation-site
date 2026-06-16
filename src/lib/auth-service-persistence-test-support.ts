import { vi } from "vitest";

import type { LoginResult } from "./auth-service";
import type { RiroAuthResult } from "./riro-auth";

type UserRow = {
  readonly bookingStatus: string;
  readonly createdAt: Date;
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly restrictionReason: string | null;
  readonly restrictedUntil: Date | null;
  readonly riroId: string | null;
  readonly role: string;
  readonly studentNumber: string;
  readonly updatedAt: Date;
};

type UserCreateData = Pick<UserRow, "bookingStatus" | "generation" | "name" | "riroId" | "role" | "studentNumber">;
type UserUpdateData = Partial<Pick<UserRow, "generation" | "name" | "riroId" | "role" | "studentNumber">>;
type UserWhereUnique = { readonly id: string } | { readonly riroId: string } | { readonly studentNumber: string };
type UserFindUniqueInput = { readonly where: UserWhereUnique };
type UserCreateInput = { readonly data: UserCreateData };
type UserUpdateInput = { readonly data: UserUpdateData; readonly where: { readonly id: string } };
type UserUpsertInput = {
  readonly create: UserCreateData;
  readonly update: UserUpdateData;
  readonly where: { readonly studentNumber: string };
};
type SessionCreateInput = {
  readonly data: { readonly expiresAt: Date; readonly tokenHash: string; readonly userId: string };
};
type MockAuthTransaction = {
  readonly user: {
    readonly create: (input: UserCreateInput) => Promise<UserRow>;
    readonly findUnique: (input: UserFindUniqueInput) => Promise<UserRow | null>;
    readonly update: (input: UserUpdateInput) => Promise<UserRow>;
    readonly upsert: (input: UserUpsertInput) => Promise<UserRow>;
  };
};
type TransactionMock = (
  operation: (transaction: MockAuthTransaction) => Promise<unknown>,
  options?: { readonly isolationLevel: string }
) => Promise<unknown>;
type RiroLoginMock = (input: { readonly id: string; readonly password: string }) => Promise<RiroAuthResult>;

export const prismaPersistenceMocks = (() => {
  const baseDate = new Date("2026-06-16T00:00:00.000Z");
  let userRows: UserRow[] = [];
  let nextUserId = 1;

  function findUser(where: UserWhereUnique): UserRow | null {
    if ("id" in where) {
      return userRows.find((user) => user.id === where.id) ?? null;
    }
    if ("riroId" in where) {
      return userRows.find((user) => user.riroId === where.riroId) ?? null;
    }
    return userRows.find((user) => user.studentNumber === where.studentNumber) ?? null;
  }

  function assertUnique(data: UserUpdateData, currentUserId: string | null): void {
    if (data.riroId) {
      const duplicatedRiroId = userRows.some((user) => user.id !== currentUserId && user.riroId === data.riroId);
      if (duplicatedRiroId) {
        throw new UniqueUserConstraintError("riroId");
      }
    }
    if (data.studentNumber) {
      const duplicatedStudentNumber = userRows.some(
        (user) => user.id !== currentUserId && user.studentNumber === data.studentNumber
      );
      if (duplicatedStudentNumber) {
        throw new UniqueUserConstraintError("studentNumber");
      }
    }
  }

  async function createUser({ data }: UserCreateInput): Promise<UserRow> {
    assertUnique(data, null);
    const user = {
      ...data,
      createdAt: baseDate,
      id: `generated-user-${nextUserId}`,
      restrictionReason: null,
      restrictedUntil: null,
      updatedAt: baseDate
    };
    nextUserId += 1;
    userRows = [...userRows, user];
    return user;
  }

  async function updateUser({ data, where }: UserUpdateInput): Promise<UserRow> {
    assertUnique(data, where.id);
    const existingUser = findUser(where);
    if (!existingUser) {
      throw new MissingUserError(where.id);
    }
    const updatedUser = { ...existingUser, ...data, updatedAt: baseDate };
    userRows = userRows.map((user) => (user.id === where.id ? updatedUser : user));
    return updatedUser;
  }

  const transactionClient = {
    user: {
      create: vi.fn(createUser),
      findUnique: vi.fn(async ({ where }: UserFindUniqueInput): Promise<UserRow | null> => findUser(where)),
      update: vi.fn(updateUser),
      upsert: vi.fn(async ({ create, update, where }: UserUpsertInput): Promise<UserRow> => {
        const existingUser = findUser(where);
        if (existingUser) {
          return updateUser({ data: update, where: { id: existingUser.id } });
        }
        return createUser({ data: create });
      })
    }
  } satisfies MockAuthTransaction;

  return {
    getUsers: () => userRows,
    reset: () => {
      userRows = [];
      nextUserId = 1;
      transactionClient.user.create.mockClear();
      transactionClient.user.findUnique.mockClear();
      transactionClient.user.update.mockClear();
      transactionClient.user.upsert.mockClear();
    },
    seedUsers: (rows: readonly UserRow[]) => {
      userRows = rows.map((row) => ({ ...row }));
      nextUserId = rows.length + 1;
    },
    sessionCreate: vi.fn(async (_input: SessionCreateInput): Promise<{ readonly id: string }> => ({ id: "session-1" })),
    transaction: vi.fn<TransactionMock>(async (operation) => operation(transactionClient)),
    transactionClient
  };
})();

export const riroPersistenceMocks = {
  loginWithRiroSchool: vi.fn<RiroLoginMock>()
};

vi.doMock("./db", () => ({
  prisma: {
    $transaction: prismaPersistenceMocks.transaction,
    session: { create: prismaPersistenceMocks.sessionCreate },
    user: prismaPersistenceMocks.transactionClient.user
  }
}));

vi.doMock("./riro-auth", () => ({
  loginWithRiroSchool: riroPersistenceMocks.loginWithRiroSchool
}));

export function resetAuthPersistenceMocks(): void {
  vi.unstubAllEnvs();
  vi.stubEnv("RIRO_MOCK_LOGIN", "false");
  prismaPersistenceMocks.reset();
  prismaPersistenceMocks.sessionCreate.mockClear();
  riroPersistenceMocks.loginWithRiroSchool.mockReset();
}

export function userRow(overrides: Partial<UserRow>): UserRow {
  const baseDate = new Date("2026-06-16T00:00:00.000Z");
  return {
    bookingStatus: "ACTIVE",
    createdAt: baseDate,
    generation: 31,
    id: "user-default",
    name: "기존학생",
    restrictionReason: null,
    restrictedUntil: null,
    riroId: "riro-default",
    role: "STUDENT",
    studentNumber: "old-default",
    updatedAt: baseDate,
    ...overrides
  };
}

export function riroSuccess(input: { readonly studentNumber: string }): RiroAuthResult {
  return {
    kind: "success",
    profile: {
      generation: 32,
      name: "재인증학생",
      role: "STUDENT",
      student: "3학년 1반",
      studentNumber: input.studentNumber
    }
  };
}

export function expectLoginSuccess(result: LoginResult): Extract<LoginResult, { readonly kind: "success" }> {
  if (result.kind === "success") {
    return result;
  }
  throw new LoginTestFailureError(result.message);
}

class UniqueUserConstraintError extends Error {
  public override readonly name = "UniqueUserConstraintError";

  public constructor(field: "riroId" | "studentNumber") {
    super(`Unique user constraint violated: ${field}`);
  }
}

class MissingUserError extends Error {
  public override readonly name = "MissingUserError";

  public constructor(userId: string) {
    super(`Missing user: ${userId}`);
  }
}

class LoginTestFailureError extends Error {
  public override readonly name = "LoginTestFailureError";

  public constructor(message: string) {
    super(`Expected login success: ${message}`);
  }
}
