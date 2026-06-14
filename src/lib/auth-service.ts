import { createHash, timingSafeEqual } from "node:crypto";

import { prisma } from "./db";
import { isLocalAdminLoginEnabled, isMockLoginEnabled } from "./env";
import { isNoDatabaseMockMode } from "./mock-dev-mode";
import { upsertMockReservationUser } from "./mock-reservation-data";
import { loginWithRiroSchool, type RiroAuthResult, type RiroProfile } from "./riro-auth";
import { createMockSessionToken, createSession, type SessionUser } from "./session";

type LoginInput = {
  readonly id: string;
  readonly password: string;
};

type RiroAuthenticator = (input: LoginInput) => Promise<RiroAuthResult>;

type AuthModeOptions = {
  readonly localAdminAccount?: LocalAdminAccount | null;
  readonly localAdminEnabled?: boolean;
  readonly mockLoginEnabled: boolean;
  readonly riroAuthenticator: RiroAuthenticator;
};

type LocalAdminAccount = {
  readonly id: string;
  readonly password: string;
};

export type LoginResult =
  | {
      readonly kind: "success";
      readonly token: string;
      readonly user: SessionUser;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly reason: "bad_response" | "invalid_credentials" | "missing_token" | "network" | "parse_failed";
    };

export async function loginUserWithRiro(input: LoginInput): Promise<LoginResult> {
  const authResult = await authenticate(input);
  if (authResult.kind === "error") {
    return authResult;
  }

  const role = resolveAppRole(authResult.profile);
  if (isNoDatabaseMockMode()) {
    const user = buildNoDatabaseMockUser(authResult.profile, role);
    upsertMockReservationUser(user);
    return {
      kind: "success",
      token: createMockSessionToken(user),
      user
    };
  }

  const user = await prisma.user.upsert({
    create: {
      bookingStatus: "ACTIVE",
      generation: authResult.profile.generation,
      name: authResult.profile.name,
      riroId: input.id,
      role,
      studentNumber: authResult.profile.studentNumber
    },
    update: {
      generation: authResult.profile.generation,
      name: authResult.profile.name,
      riroId: input.id,
      role
    },
    where: { studentNumber: authResult.profile.studentNumber }
  });

  const token = await createSession(user.id);
  return {
    kind: "success",
    token,
    user: {
      bookingStatus: user.bookingStatus,
      generation: user.generation,
      id: user.id,
      name: user.name,
      restrictedUntil: user.restrictedUntil ? user.restrictedUntil.toISOString() : null,
      role: user.role,
      studentNumber: user.studentNumber
    }
  };
}

function buildNoDatabaseMockUser(profile: RiroProfile, role: "ADMIN" | "STUDENT"): SessionUser {
  return {
    bookingStatus: "ACTIVE",
    generation: profile.generation,
    id: `mock-${profile.studentNumber}`,
    name: profile.name,
    restrictedUntil: null,
    role,
    studentNumber: profile.studentNumber
  };
}

async function authenticate(input: LoginInput): Promise<RiroAuthResult> {
  return authenticateWithConfiguredMode(input, {
    localAdminAccount: getLocalAdminAccountFromEnv(),
    localAdminEnabled: isLocalAdminLoginEnabled(),
    mockLoginEnabled: isMockLoginEnabled(),
    riroAuthenticator: (authInput) => loginWithRiroSchool({ id: authInput.id, password: authInput.password })
  });
}

export async function authenticateWithConfiguredMode(
  input: LoginInput,
  options: AuthModeOptions
): Promise<RiroAuthResult> {
  const localAdminResult = authenticateLocalAdmin(
    input,
    options.localAdminAccount ?? null,
    options.localAdminEnabled ?? false
  );
  if (localAdminResult) {
    return localAdminResult;
  }
  if (options.mockLoginEnabled) {
    return mockRiroLogin(input);
  }
  return options.riroAuthenticator(input);
}

function authenticateLocalAdmin(input: LoginInput, account: LocalAdminAccount | null, enabled: boolean): RiroAuthResult | null {
  if (!account || input.id !== account.id) {
    return null;
  }
  if (!enabled) {
    return null;
  }

  const passwordSafetyError = validateLocalAdminPassword(account.password);
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
    profile: {
      generation: 0,
      name: "관리자",
      role: "TEACHER",
      student: "관리자 계정",
      studentNumber: "0"
    }
  };
}

function validateLocalAdminPassword(password: string): RiroAuthResult | null {
  if (password.length < 12) {
    return {
      kind: "error",
      message: "로컬 관리자 비밀번호는 12자 이상이어야 합니다.",
      reason: "bad_response"
    };
  }
  return null;
}

function getLocalAdminAccountFromEnv(): LocalAdminAccount | null {
  const id = process.env.ADMIN_LOGIN_ID?.trim();
  const password = process.env.ADMIN_LOGIN_PASSWORD;
  if (!id || !password) {
    return null;
  }
  return { id, password };
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function mockRiroLogin(input: LoginInput): RiroAuthResult {
  if (!input.id || !input.password) {
    return {
      kind: "error",
      message: "아이디 또는 비밀번호가 틀렸습니다.",
      reason: "invalid_credentials"
    };
  }

  const isAdmin = input.id === "admin";
  return {
    kind: "success",
    profile: {
      generation: 31,
      name: isAdmin ? "관리자" : "테스트학생",
      role: isAdmin ? "TEACHER" : "STUDENT",
      student: isAdmin ? "교사" : "2학년 3반",
      studentNumber: isAdmin ? "0" : normalizeMockStudentNumber(input.id)
    }
  };
}

export function resolveAppRole(
  profile: RiroProfile,
  adminNumbers = parseAdminStudentNumbers(process.env.ADMIN_STUDENT_NUMBERS ?? "")
): "ADMIN" | "STUDENT" {
  if (profile.role === "TEACHER" || adminNumbers.has(profile.studentNumber)) {
    return "ADMIN";
  }
  return "STUDENT";
}

function parseAdminStudentNumbers(value: string): ReadonlySet<string> {
  return new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
}

function normalizeMockStudentNumber(id: string): string {
  const digits = id.replace(/\D/gu, "");
  if (digits.length >= 4) {
    return digits.slice(-5);
  }
  return `9${digits.padStart(4, "0")}`;
}
