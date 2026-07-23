import { afterEach, describe, expect, it, vi } from "vitest";

import { authenticateWithConfiguredMode, loginUserWithRiro, resolveAppRole } from "./auth-service";
import type { RiroAuthResult } from "./riro-auth";

const successFromRealAuthenticator: RiroAuthResult = {
  kind: "success",
  profile: {
    generation: 31,
    name: "실제인증학생",
    role: "STUDENT",
    student: "2학년 3반",
    studentNumber: "12345"
  }
};

describe("authenticateWithConfiguredMode", () => {
  it("uses the mock admin shortcut only when mock mode is enabled", async () => {
    const result = await authenticateWithConfiguredMode(
      { id: "admin", password: "password" },
      {
        mockLoginEnabled: true,
        riroAuthenticator: async () => successFromRealAuthenticator
      }
    );

    expect(result).toEqual({
      kind: "success",
      profile: {
        generation: 31,
        name: "관리자",
        role: "TEACHER",
        student: "교사",
        studentNumber: "0"
      }
    });
  });

  it("uses the real Riro authenticator when mock mode is disabled", async () => {
    const calls: string[] = [];
    const result = await authenticateWithConfiguredMode(
      { id: "admin", password: "password" },
      {
        mockLoginEnabled: false,
        riroAuthenticator: async (input) => {
          calls.push(`${input.id}:${input.password}`);
          return successFromRealAuthenticator;
        }
      }
    );

    expect(calls).toEqual(["admin:password"]);
    expect(result).toBe(successFromRealAuthenticator);
  });

  it("ignores a configured local admin account unless local admin login is enabled", async () => {
    const calls: string[] = [];
    const result = await authenticateWithConfiguredMode(
      { id: "site-admin", password: "local-secret" },
      {
        localAdminAccount: { id: "site-admin", password: "local-secret" },
        localAdminEnabled: false,
        mockLoginEnabled: false,
        riroAuthenticator: async (input) => {
          calls.push(`${input.id}:${input.password}`);
          return successFromRealAuthenticator;
        }
      }
    );

    expect(calls).toEqual(["site-admin:local-secret"]);
    expect(result).toBe(successFromRealAuthenticator);
  });

  it("does not enable local admin accounts through mock mode", async () => {
    const result = await authenticateWithConfiguredMode(
      { id: "site-admin", password: "local-secret" },
      {
        localAdminAccount: { id: "site-admin", password: "local-secret" },
        mockLoginEnabled: true,
        riroAuthenticator: async () => successFromRealAuthenticator
      }
    );

    expect(result).toEqual({
      kind: "success",
      profile: {
        generation: 31,
        name: "테스트학생",
        role: "STUDENT",
        student: "2학년 3반",
        studentNumber: "90000"
      }
    });
  });

  it("uses a configured local admin account before real Riro auth", async () => {
    const calls: string[] = [];
    const result = await authenticateWithConfiguredMode(
      { id: "site-admin", password: "local-secret" },
      {
        localAdminAccount: { id: "site-admin", password: "local-secret" },
        localAdminEnabled: true,
        mockLoginEnabled: false,
        riroAuthenticator: async (input) => {
          calls.push(`${input.id}:${input.password}`);
          return successFromRealAuthenticator;
        }
      }
    );

    expect(calls).toEqual([]);
    expect(result).toEqual({
      kind: "success",
      profile: {
        generation: 0,
        name: "관리자",
        role: "TEACHER",
        student: "관리자 계정",
        studentNumber: "0"
      }
    });
  });

  it("uses a configured local student account before real Riro auth", async () => {
    const calls: string[] = [];
    const result = await authenticateWithConfiguredMode(
      { id: "site-student", password: "local-student-secret" },
      {
        localStudentAccount: {
          id: "site-student",
          password: "local-student-secret",
          studentNumber: "91001"
        },
        localStudentEnabled: true,
        mockLoginEnabled: false,
        riroAuthenticator: async (input) => {
          calls.push(`${input.id}:${input.password}`);
          return successFromRealAuthenticator;
        }
      }
    );

    expect(calls).toEqual([]);
    expect(result).toEqual({
      kind: "success",
      profile: {
        generation: 0,
        name: "일반 계정",
        role: "STUDENT",
        student: "로컬 학생 계정",
        studentNumber: "91001"
      }
    });
  });

  it("rejects a weak local admin password without calling real Riro auth", async () => {
    const calls: string[] = [];
    const result = await authenticateWithConfiguredMode(
      { id: "site-admin", password: "short" },
      {
        localAdminAccount: { id: "site-admin", password: "short" },
        localAdminEnabled: true,
        mockLoginEnabled: false,
        riroAuthenticator: async (input) => {
          calls.push(`${input.id}:${input.password}`);
          return successFromRealAuthenticator;
        }
      }
    );

    expect(calls).toEqual([]);
    expect(result).toEqual({
      kind: "error",
      message: "로컬 관리자 비밀번호는 12자 이상이어야 합니다.",
      reason: "bad_response"
    });
  });

  it("rejects a configured local admin password without calling real Riro auth", async () => {
    const calls: string[] = [];
    const result = await authenticateWithConfiguredMode(
      { id: "site-admin", password: "wrong" },
      {
        localAdminAccount: { id: "site-admin", password: "local-secret" },
        localAdminEnabled: true,
        mockLoginEnabled: false,
        riroAuthenticator: async (input) => {
          calls.push(`${input.id}:${input.password}`);
          return successFromRealAuthenticator;
        }
      }
    );

    expect(calls).toEqual([]);
    expect(result).toEqual({
      kind: "error",
      message: "아이디 또는 비밀번호가 틀렸습니다.",
      reason: "invalid_credentials"
    });
  });
});

describe("resolveAppRole", () => {
  it("does not treat the literal admin login id as admin in real Riro mode", () => {
    expect(resolveAppRole(successFromRealAuthenticator.profile)).toBe("STUDENT");
  });

  it("allows teachers and configured student numbers to become admins", () => {
    expect(resolveAppRole({ ...successFromRealAuthenticator.profile, role: "TEACHER" })).toBe("ADMIN");
    expect(resolveAppRole(successFromRealAuthenticator.profile, new Set(["12345"]))).toBe("ADMIN");
  });
});

describe("loginUserWithRiro", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a mock session without touching the database in no-DB mock mode", async () => {
    vi.stubEnv("RIRO_MOCK_LOGIN", "true");
    vi.stubEnv("DATABASE_URL", "");

    const result = await loginUserWithRiro({ id: "12345", password: "password" });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") {
      throw new Error("Expected mock login to succeed");
    }
    expect(result.token).toMatch(/^mock\./u);
    expect(result.user).toMatchObject({
      bookingStatus: "ACTIVE",
      role: "STUDENT",
      shadowBanProfile: "NORMAL",
      studentNumber: "12345"
    });
  });
});
