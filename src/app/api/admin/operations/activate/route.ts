import { NextResponse } from "next/server";
import { z } from "zod";

import { activateApplicationContract } from "@/lib/application-contract-activation";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { readJsonRequest } from "@/lib/request-json";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { enforceAdminMutationRateLimit } from "@/lib/route-rate-limit";
import { ForbiddenSessionError, requireAdminSession, UnauthorizedSessionError } from "@/lib/session";

const ActivationRequestSchema = z.object({}).strict();

export async function POST(request: Request): Promise<NextResponse> {
  const safetyError = requireMutatingRequestSafety(request);
  if (safetyError) return jsonMutatingRequestSafetyError(safetyError);

  try {
    const session = await requireAdminSession();
    const csrf = await validateRequestCsrf(request, session.id);
    if (csrf.kind === "error") {
      return jsonError(403, csrf.reason, messageForCsrfError(csrf.reason));
    }
    const rateLimit = await enforceAdminMutationRateLimit(request, session.user.id);
    if (rateLimit.kind === "blocked") return jsonRateLimitError(rateLimit);
    const parsed = await readJsonRequest(request, {
      message: "애플리케이션 계약 활성화 요청 형식이 올바르지 않습니다.",
      schema: ActivationRequestSchema
    });
    if (parsed.kind === "error") return parsed.response;

    const activation = await activateApplicationContract({ source: "ADMIN" });
    return NextResponse.json({ activation });
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) return jsonError(401, "unauthorized", error.message);
    if (error instanceof ForbiddenSessionError) return jsonError(403, "forbidden", error.message);
    throw error;
  }
}
