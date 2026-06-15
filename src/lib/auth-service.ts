import { prisma } from "./db";
import { isLocalAdminLoginEnabled, isLocalStudentLoginEnabled, isMockLoginEnabled } from "./env";
import {
  authenticateLocalLogin,
  buildLocalAdminLoginAccount,
  buildLocalStudentLoginAccount,
  getLocalAdminAccountFromEnv,
  getLocalStudentAccountFromEnv,
  getLocalStudentAccountsFromEnv,
  type LocalAdminAccount,
  type LocalStudentAccount
} from "./local-login";
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
  readonly localStudentAccount?: LocalStudentAccount | null;
  readonly localStudentAccounts?: readonly LocalStudentAccount[] | null;
  readonly localStudentEnabled?: boolean;
  readonly mockLoginEnabled: boolean;
  readonly riroAuthenticator: RiroAuthenticator;
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
      restrictionReason: user.restrictionReason,
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
    restrictionReason: null,
    restrictedUntil: null,
    role,
    studentNumber: profile.studentNumber
  };
}

async function authenticate(input: LoginInput): Promise<RiroAuthResult> {
  return authenticateWithConfiguredMode(input, {
    localAdminAccount: getLocalAdminAccountFromEnv(),
    localAdminEnabled: isLocalAdminLoginEnabled(),
    localStudentAccount: getLocalStudentAccountFromEnv(),
    localStudentAccounts: getLocalStudentAccountsFromEnv(),
    localStudentEnabled: isLocalStudentLoginEnabled(),
    mockLoginEnabled: isMockLoginEnabled(),
    riroAuthenticator: (authInput) => loginWithRiroSchool({ id: authInput.id, password: authInput.password })
  });
}

export async function authenticateWithConfiguredMode(
  input: LoginInput,
  options: AuthModeOptions
): Promise<RiroAuthResult> {
  const localLoginResult = authenticateLocalLogin(input, [
    buildLocalAdminLoginAccount(
      options.localAdminAccount ?? null,
      options.localAdminEnabled ?? false
    ),
    ...localStudentAccountsForOptions(options).map((account) =>
      buildLocalStudentLoginAccount(account, options.localStudentEnabled ?? false)
    )
  ]);
  if (localLoginResult) {
    return localLoginResult;
  }
  if (options.mockLoginEnabled) {
    return mockRiroLogin(input);
  }
  return options.riroAuthenticator(input);
}

function localStudentAccountsForOptions(options: AuthModeOptions): readonly LocalStudentAccount[] {
  if (options.localStudentAccounts !== undefined && options.localStudentAccounts !== null) {
    return options.localStudentAccounts;
  }
  return options.localStudentAccount ? [options.localStudentAccount] : [];
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
