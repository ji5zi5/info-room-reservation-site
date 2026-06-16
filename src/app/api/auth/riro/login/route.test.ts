import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoginResult } from "@/lib/auth-service";
import type { RateLimitResult } from "@/lib/rate-limit";

import { POST } from "./route";

type LoginInput = {
  readonly id: string;
  readonly password: string;
};

type LoginUserWithRiro = (input: LoginInput) => Promise<LoginResult>;
type LoginRateLimit = (request: Request, loginId: string) => Promise<RateLimitResult>;
type LoginIpRateLimit = (request: Request) => Promise<RateLimitResult>;
type SetSessionCookie = (response: Response, token: string) => void;

const routeMocks = vi.hoisted(() => ({
  enforceLoginIpRateLimit: vi.fn<LoginIpRateLimit>(),
  enforceLoginRateLimit: vi.fn<LoginRateLimit>(),
  isNoDatabaseMockMode: vi.fn<() => boolean>(),
  loginUserWithRiro: vi.fn<LoginUserWithRiro>(),
  setSessionCookie: vi.fn<SetSessionCookie>()
}));

vi.mock("@/lib/auth-service", () => ({
  loginUserWithRiro: routeMocks.loginUserWithRiro
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode
}));

vi.mock("@/lib/route-rate-limit", () => ({
  enforceLoginIpRateLimit: routeMocks.enforceLoginIpRateLimit,
  enforceLoginRateLimit: routeMocks.enforceLoginRateLimit
}));

vi.mock("@/lib/session", () => ({
  setSessionCookie: routeMocks.setSessionCookie
}));

const allowedRateLimit: RateLimitResult = {
  kind: "allowed",
  remaining: 1,
  resetAt: new Date("2026-06-15T00:01:00.000Z")
};

const blockedRateLimit: RateLimitResult = {
  kind: "blocked",
  limit: 30,
  resetAt: new Date(Date.now() + 60_000)
};

const successfulLogin: LoginResult = {
  kind: "success",
  token: "test-session-token",
  user: {
    bookingStatus: "ACTIVE",
    generation: 31,
    id: "user-1",
    name: "테스트학생",
    restrictionReason: null,
    restrictedUntil: null,
    role: "STUDENT",
    studentNumber: "90001"
  }
};

const invalidCredentialsLogin: LoginResult = {
  kind: "error",
  message: "비밀번호를 다시 확인하세요. (2/5회 오류)",
  reason: "invalid_credentials"
};

describe("Riro login route", () => {
  beforeEach(() => {
    routeMocks.enforceLoginIpRateLimit.mockReset();
    routeMocks.enforceLoginRateLimit.mockReset();
    routeMocks.isNoDatabaseMockMode.mockReset();
    routeMocks.loginUserWithRiro.mockReset();
    routeMocks.setSessionCookie.mockReset();

    routeMocks.enforceLoginIpRateLimit.mockResolvedValue(allowedRateLimit);
    routeMocks.enforceLoginRateLimit.mockResolvedValue(allowedRateLimit);
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.loginUserWithRiro.mockResolvedValue(successfulLogin);
  });

  it("checks the IP login bucket before returning bad request for malformed JSON", async () => {
    const response = await POST(loginRequest("{"));

    expect(response.status).toBe(400);
    expect(routeMocks.enforceLoginIpRateLimit).toHaveBeenCalledTimes(1);
    expect(routeMocks.enforceLoginRateLimit).not.toHaveBeenCalled();
    expect(routeMocks.loginUserWithRiro).not.toHaveBeenCalled();
  });

  it("returns rate limited before parsing malformed JSON when the IP bucket is blocked", async () => {
    routeMocks.enforceLoginIpRateLimit.mockResolvedValue(blockedRateLimit);

    const response = await POST(loginRequest("{"));

    expect(response.status).toBe(429);
    expect(routeMocks.enforceLoginIpRateLimit).toHaveBeenCalledTimes(1);
    expect(routeMocks.enforceLoginRateLimit).not.toHaveBeenCalled();
    expect(routeMocks.loginUserWithRiro).not.toHaveBeenCalled();
  });

  it("checks the parsed login-id bucket once for a valid login body", async () => {
    const response = await POST(loginRequest(JSON.stringify({ id: "student-1", password: "example-password" })));

    expect(response.status).toBe(200);
    expect(routeMocks.enforceLoginIpRateLimit).toHaveBeenCalledTimes(1);
    expect(routeMocks.enforceLoginRateLimit).toHaveBeenCalledTimes(1);
    expect(routeMocks.enforceLoginRateLimit).toHaveBeenCalledWith(expect.any(Request), "student-1");
    expect(routeMocks.loginUserWithRiro).toHaveBeenCalledTimes(1);
  });

  it("trims an email-shaped login id before rate limiting and authenticating", async () => {
    const response = await POST(loginRequest(JSON.stringify({ id: "  student@gmail.com  ", password: "example-password" })));

    expect(response.status).toBe(200);
    expect(routeMocks.enforceLoginRateLimit).toHaveBeenCalledWith(expect.any(Request), "student@gmail.com");
    expect(routeMocks.loginUserWithRiro).toHaveBeenCalledWith({
      id: "student@gmail.com",
      password: "example-password"
    });
  });

  it("keeps no-database mock login free from rate-limit buckets", async () => {
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);

    const response = await POST(loginRequest(JSON.stringify({ id: "student-1", password: "example-password" })));

    expect(response.status).toBe(200);
    expect(routeMocks.enforceLoginIpRateLimit).not.toHaveBeenCalled();
    expect(routeMocks.enforceLoginRateLimit).not.toHaveBeenCalled();
    expect(routeMocks.loginUserWithRiro).toHaveBeenCalledTimes(1);
  });

  it("masks shadow-banned student fields in the login response only", async () => {
    routeMocks.loginUserWithRiro.mockResolvedValue({
      kind: "success",
      token: "raw-shadow-session-token",
      user: {
        bookingStatus: "SHADOW_BANNED",
        generation: 31,
        id: "user-shadow",
        name: "테스트학생",
        restrictionReason: "블랙리스트",
        restrictedUntil: "2026-07-01T00:00:00.000Z",
        role: "STUDENT",
        studentNumber: "90001"
      }
    });

    const response = await POST(loginRequest(JSON.stringify({ id: "student-1", password: "example-password" })));

    expect(response.status).toBe(200);
    expect(routeMocks.setSessionCookie).toHaveBeenCalledWith(response, "raw-shadow-session-token");
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      user: {
        bookingStatus: "ACTIVE",
        restrictionReason: null,
        restrictedUntil: null
      }
    });
    expect(text).not.toContain("SHADOW_BANNED");
    expect(text).not.toContain("블랙리스트");
  });

  it("returns unauthorized JSON for invalid Riro credentials without echoing the password", async () => {
    routeMocks.loginUserWithRiro.mockResolvedValue(invalidCredentialsLogin);

    const response = await POST(loginRequest(JSON.stringify({ id: "student-1", password: "secret-password" })));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_credentials",
        message: "비밀번호를 다시 확인하세요. (2/5회 오류)"
      }
    });
    expect(routeMocks.setSessionCookie).not.toHaveBeenCalled();
  });
});

function loginRequest(body: string): Request {
  return new Request("https://example.test/api/auth/riro/login", {
    body,
    headers: {
      "content-type": "application/json",
      origin: "https://example.test"
    },
    method: "POST"
  });
}
