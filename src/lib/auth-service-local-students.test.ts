import { describe, expect, it } from "vitest";

import { authenticateWithConfiguredMode } from "./auth-service";
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

describe("multiple local student fallback accounts", () => {
  it("uses every configured local student account before real Riro auth", async () => {
    const calls: string[] = [];
    const options = {
      localStudentAccounts: [
        { id: "local_student_a", password: "test-student-secret", studentNumber: "local_student_a" },
        { id: "local_student_b", password: "test-student-secret", studentNumber: "local_student_b" }
      ],
      localStudentEnabled: true,
      mockLoginEnabled: false,
      riroAuthenticator: async (input: { readonly id: string; readonly password: string }) => {
        calls.push(`${input.id}:${input.password}`);
        return successFromRealAuthenticator;
      }
    };

    const firstLocalStudentResult = await authenticateWithConfiguredMode(
      { id: "local_student_a", password: "test-student-secret" },
      options
    );
    const secondLocalStudentResult = await authenticateWithConfiguredMode(
      { id: "local_student_b", password: "test-student-secret" },
      options
    );

    expect(calls).toEqual([]);
    expect(firstLocalStudentResult).toMatchObject({ kind: "success", profile: { studentNumber: "local_student_a" } });
    expect(secondLocalStudentResult).toMatchObject({ kind: "success", profile: { studentNumber: "local_student_b" } });
  });

  it("rejects a local student id password when the shared fallback password differs", async () => {
    const calls: string[] = [];
    const options = {
      localStudentAccounts: [
        { id: "local_student_a", password: "test-student-secret", studentNumber: "local_student_a" },
        { id: "local_student_b", password: "test-student-secret", studentNumber: "local_student_b" }
      ],
      localStudentEnabled: true,
      mockLoginEnabled: false,
      riroAuthenticator: async (input: { readonly id: string; readonly password: string }) => {
        calls.push(`${input.id}:${input.password}`);
        return successFromRealAuthenticator;
      }
    };

    const firstLocalStudentResult = await authenticateWithConfiguredMode(
      { id: "local_student_a", password: "local_student_a" },
      options
    );

    expect(calls).toEqual([]);
    expect(firstLocalStudentResult).toMatchObject({ kind: "error", reason: "invalid_credentials" });
  });

  it("rejects a local student id password when the configured fallback secret is weak", async () => {
    const calls: string[] = [];
    const result = await authenticateWithConfiguredMode(
      { id: "local_student_a", password: "local_student_a" },
      {
        localStudentAccounts: [{ id: "local_student_a", password: "short", studentNumber: "local_student_a" }],
        localStudentEnabled: true,
        mockLoginEnabled: false,
        riroAuthenticator: async (input: { readonly id: string; readonly password: string }) => {
          calls.push(`${input.id}:${input.password}`);
          return successFromRealAuthenticator;
        }
      }
    );

    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      kind: "error",
      message: "로컬 학생 비밀번호는 12자 이상이어야 합니다.",
      reason: "bad_response"
    });
  });
});
