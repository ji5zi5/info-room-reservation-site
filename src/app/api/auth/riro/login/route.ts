import { NextResponse } from "next/server";
import { z } from "zod";

import { loginUserWithRiro } from "@/lib/auth-service";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { readJsonRequest } from "@/lib/request-json";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { enforceLoginIpRateLimit, enforceLoginRateLimit } from "@/lib/route-rate-limit";
import { setSessionCookie } from "@/lib/session";

const LoginRequestSchema = z.object({
  id: z.string().min(1),
  password: z.string().min(1)
});

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const requestSafetyError = requireMutatingRequestSafety(request);
    if (requestSafetyError) {
      return jsonMutatingRequestSafetyError(requestSafetyError);
    }

    const skipRateLimit = isNoDatabaseMockMode();
    if (!skipRateLimit) {
      const ipRateLimitResult = await enforceLoginIpRateLimit(request);
      if (ipRateLimitResult.kind === "blocked") {
        return jsonRateLimitError(ipRateLimitResult);
      }
    }

    const parsed = await readJsonRequest(request, {
      message: "아이디와 비밀번호를 입력해주세요.",
      schema: LoginRequestSchema
    });
    if (parsed.kind === "error") {
      return parsed.response;
    }

    if (!skipRateLimit) {
      const rateLimitResult = await enforceLoginRateLimit(request, parsed.data.id);
      if (rateLimitResult.kind === "blocked") {
        return jsonRateLimitError(rateLimitResult);
      }
    }

    const result = await loginUserWithRiro(parsed.data);
    if (result.kind === "error") {
      const status = result.reason === "invalid_credentials" ? 401 : 502;
      return jsonError(status, result.reason === "invalid_credentials" ? "invalid_credentials" : "server_error", result.message);
    }

    const response = NextResponse.json({ user: result.user });
    setSessionCookie(response, result.token);
    return response;
  } catch (error) {
    if (error instanceof Error) {
      console.error("Login route failed", error);
      return jsonError(500, "server_error", "로그인 처리 중 오류가 발생했습니다.");
    }
    throw error;
  }
}
