import { NextResponse } from "next/server";
import { z } from "zod";

import { loginUserWithRiro } from "@/lib/auth-service";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { enforceLoginRateLimit } from "@/lib/route-rate-limit";
import { setSessionCookie } from "@/lib/session";

const LoginRequestSchema = z.object({
  id: z.string().min(1),
  password: z.string().min(1)
});

export async function POST(request: Request): Promise<NextResponse> {
  const requestSafetyError = requireMutatingRequestSafety(request);
  if (requestSafetyError) {
    return jsonMutatingRequestSafetyError(requestSafetyError);
  }

  const parsed = LoginRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return jsonError(400, "bad_request", "아이디와 비밀번호를 입력해주세요.");
  }

  const rateLimitResult = await enforceLoginRateLimit(request, parsed.data.id);
  if (rateLimitResult.kind === "blocked") {
    return jsonRateLimitError(rateLimitResult);
  }

  const result = await loginUserWithRiro(parsed.data);
  if (result.kind === "error") {
    const status = result.reason === "invalid_credentials" ? 401 : 502;
    return jsonError(status, result.reason === "invalid_credentials" ? "invalid_credentials" : "server_error", result.message);
  }

  const response = NextResponse.json({ user: result.user });
  setSessionCookie(response, result.token);
  return response;
}
