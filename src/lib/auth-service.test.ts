import { describe, expect, it } from "vitest";

import { authenticateWithConfiguredMode, resolveAppRole } from "./auth-service";
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
