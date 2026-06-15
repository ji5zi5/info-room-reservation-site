import { createHash, timingSafeEqual } from "node:crypto";

import type { RiroAuthResult, RiroProfile } from "./riro-auth";

export type LocalLoginInput = {
  readonly id: string;
  readonly password: string;
};

export type LocalAdminAccount = {
  readonly id: string;
  readonly password: string;
};

export type LocalStudentAccount = LocalAdminAccount & {
  readonly studentNumber: string;
};

type LocalLoginAccount = {
  readonly enabled: boolean;
  readonly id: string;
  readonly password: string;
  readonly profile: RiroProfile;
  readonly weakPasswordMessage: string;
};

const MIN_LOCAL_PASSWORD_LENGTH = 12;
const DEFAULT_LOCAL_STUDENT_NUMBER = "local-student";

export function authenticateLocalLogin(
  input: LocalLoginInput,
  accounts: readonly (LocalLoginAccount | null)[]
): RiroAuthResult | null {
  const account = accounts.find((candidate) => candidate !== null && candidate.enabled && candidate.id === input.id);
  if (!account) {
    return null;
  }

  const passwordSafetyError = validateLocalPassword(account.password, account.weakPasswordMessage);
  if (passwordSafetyError) {
    return passwordSafetyError;
  }

  if (!constantTimeEqual(input.password, account.password)) {
    return {
      kind: "error",
      message: "아이디 또는 비밀번호가 틀렸습니다.",
      reason: "invalid_credentials"
    };
  }

  return {
    kind: "success",
    profile: account.profile
  };
}

export function buildLocalAdminLoginAccount(
  account: LocalAdminAccount | null,
  enabled: boolean
): LocalLoginAccount | null {
  if (!account) {
    return null;
  }
  return {
    enabled,
    id: account.id,
    password: account.password,
    profile: {
      generation: 0,
      name: "관리자",
      role: "TEACHER",
      student: "관리자 계정",
      studentNumber: "0"
    },
    weakPasswordMessage: "로컬 관리자 비밀번호는 12자 이상이어야 합니다."
  };
}

export function buildLocalStudentLoginAccount(
  account: LocalStudentAccount | null,
  enabled: boolean
): LocalLoginAccount | null {
  if (!account) {
    return null;
  }
  return {
    enabled,
    id: account.id,
    password: account.password,
    profile: {
      generation: 0,
      name: "일반 계정",
      role: "STUDENT",
      student: "로컬 학생 계정",
      studentNumber: account.studentNumber
    },
    weakPasswordMessage: "로컬 학생 비밀번호는 12자 이상이어야 합니다."
  };
}

export function getLocalAdminAccountFromEnv(): LocalAdminAccount | null {
  const id = normalizeOptional(process.env.ADMIN_LOGIN_ID);
  const password = process.env.ADMIN_LOGIN_PASSWORD;
  if (!id || !password) {
    return null;
  }
  return { id, password };
}

export function getLocalStudentAccountFromEnv(): LocalStudentAccount | null {
  const id = normalizeOptional(process.env.LOCAL_STUDENT_LOGIN_ID);
  const password = process.env.LOCAL_STUDENT_LOGIN_PASSWORD;
  if (!id || !password) {
    return null;
  }
  return {
    id,
    password,
    studentNumber: normalizeOptional(process.env.LOCAL_STUDENT_NUMBER) ?? DEFAULT_LOCAL_STUDENT_NUMBER
  };
}

function validateLocalPassword(password: string, message: string): RiroAuthResult | null {
  if (password.length < MIN_LOCAL_PASSWORD_LENGTH) {
    return {
      kind: "error",
      message,
      reason: "bad_response"
    };
  }
  return null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function normalizeOptional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
