import { Prisma, type User } from "@prisma/client";

import { prisma } from "./db";
import type { RiroProfile } from "./riro-auth";

type AuthenticatedUserInput = {
  readonly loginId: string;
  readonly profile: RiroProfile;
  readonly role: "ADMIN" | "STUDENT";
};

export type PersistAuthenticatedUserResult =
  | { readonly kind: "success"; readonly user: User }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly reason: "bad_response";
    };

const PRISMA_AUTH_TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable
} satisfies { readonly isolationLevel: Prisma.TransactionIsolationLevel };

export async function persistAuthenticatedUserResult(
  input: AuthenticatedUserInput
): Promise<PersistAuthenticatedUserResult> {
  try {
    return { kind: "success", user: await persistAuthenticatedUser(input) };
  } catch (error) {
    if (error instanceof AccountIdentityConflictError) {
      return {
        kind: "error",
        message: "계정 정보가 충돌했습니다. 관리자에게 문의해주세요.",
        reason: "bad_response"
      };
    }
    throw error;
  }
}

async function persistAuthenticatedUser(input: AuthenticatedUserInput): Promise<User> {
  const userData = authenticatedUserData(input);
  return prisma.$transaction(async (transaction) => {
    const riroUser = await transaction.user.findUnique({ where: { riroId: input.loginId } });
    if (riroUser) {
      if (riroUser.studentNumber !== input.profile.studentNumber) {
        const studentNumberUser = await transaction.user.findUnique({
          where: { studentNumber: input.profile.studentNumber }
        });
        if (studentNumberUser && studentNumberUser.id !== riroUser.id) {
          if (studentNumberUser.riroId) {
            throw new AccountIdentityConflictError(input.loginId, input.profile.studentNumber);
          }
          await transaction.user.update({
            data: { riroId: null, studentNumber: relinkedStudentNumber(studentNumberUser) },
            where: { id: studentNumberUser.id }
          });
        }
      }
      return transaction.user.update({ data: userData, where: { id: riroUser.id } });
    }

    const studentNumberUser = await transaction.user.findUnique({
      where: { studentNumber: input.profile.studentNumber }
    });
    if (studentNumberUser) {
      return transaction.user.update({ data: userData, where: { id: studentNumberUser.id } });
    }
    return transaction.user.create({ data: { bookingStatus: "ACTIVE", ...userData } });
  }, PRISMA_AUTH_TRANSACTION_OPTIONS);
}

function authenticatedUserData(input: AuthenticatedUserInput): {
  readonly generation: number;
  readonly name: string;
  readonly riroId: string;
  readonly role: "ADMIN" | "STUDENT";
  readonly studentNumber: string;
} {
  return {
    generation: input.profile.generation,
    name: input.profile.name,
    riroId: input.loginId,
    role: input.role,
    studentNumber: input.profile.studentNumber
  };
}

function relinkedStudentNumber(user: Pick<User, "id" | "studentNumber">): string {
  return `relinked:${user.studentNumber}:${user.id}`;
}

class AccountIdentityConflictError extends Error {
  public override readonly name = "AccountIdentityConflictError";

  public constructor(loginId: string, studentNumber: string) {
    super(`Riro login ${loginId} conflicts with existing student number ${studentNumber}`);
  }
}
