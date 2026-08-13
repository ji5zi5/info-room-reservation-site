import { NextResponse } from "next/server";
import { z } from "zod";

import { bulkCancelAdministratorReservations } from "@/lib/admin-bulk-cancellation";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { readJsonRequest } from "@/lib/request-json";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { hashRequestClientIp } from "@/lib/request-source";
import { enforceAdminMutationRateLimit } from "@/lib/route-rate-limit";
import { ForbiddenSessionError, requireAdminSession, UnauthorizedSessionError } from "@/lib/session";

const AdminBulkCancelRequestSchema = z.object({
  mode: z.enum(["preview", "execute"]),
  reason: z.string().trim().min(1).max(200),
  reservationIds: z.array(z.string().trim().min(1)).min(1).max(50)
    .refine((ids) => new Set(ids).size === ids.length)
}).strict();

export async function POST(request: Request): Promise<NextResponse> {
  const requestSafetyError = requireMutatingRequestSafety(request);
  if (requestSafetyError) {
    return jsonMutatingRequestSafetyError(requestSafetyError);
  }

  try {
    const session = await requireAdminSession();
    const csrfResult = await validateRequestCsrf(request, session.id);
    if (csrfResult.kind === "error") {
      return jsonError(403, csrfResult.reason, messageForCsrfError(csrfResult.reason));
    }
    const rateLimitResult = await enforceAdminMutationRateLimit(request, session.user.id);
    if (rateLimitResult.kind === "blocked") {
      return jsonRateLimitError(rateLimitResult);
    }
    const parsed = await readJsonRequest(request, {
      message: "일괄 취소 요청을 확인하세요.",
      schema: AdminBulkCancelRequestSchema
    });
    if (parsed.kind === "error") {
      return parsed.response;
    }

    const result = await bulkCancelAdministratorReservations({
      actor: { id: session.user.id, role: "ADMIN" },
      ipHash: hashRequestClientIp(request),
      mode: parsed.data.mode,
      reason: parsed.data.reason,
      reservationIds: parsed.data.reservationIds,
      source: { kind: "WEB_ADMIN" }
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      return jsonError(401, "unauthorized", error.message);
    }
    if (error instanceof ForbiddenSessionError) {
      return jsonError(403, "forbidden", error.message);
    }
    return jsonError(500, "server_error", "관리자 일괄 예약 취소 처리 중 오류가 발생했습니다.");
  }
}
