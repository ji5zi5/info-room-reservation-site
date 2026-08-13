import { NextResponse } from "next/server";
import { z } from "zod";

import { markAdministratorReservationNoShow } from "@/lib/admin-no-show-operations";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { readJsonRequest } from "@/lib/request-json";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { hashRequestClientIp } from "@/lib/request-source";
import { enforceAdminMutationRateLimit } from "@/lib/route-rate-limit";
import { requireAdminSession, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

const NoShowRequestSchema = z.object({
  reason: z.string().max(200).default("정보실 예약 노쇼")
});

export async function POST(request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<NextResponse> {
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
    const admin = session.user;
    const rateLimitResult = await enforceAdminMutationRateLimit(request, admin.id);
    if (rateLimitResult.kind === "blocked") {
      return jsonRateLimitError(rateLimitResult);
    }
    const params = await context.params;
    const parsed = await readJsonRequest(request, {
      message: "노쇼 요청 형식이 올바르지 않습니다.",
      schema: NoShowRequestSchema
    });
    if (parsed.kind === "error") {
      return parsed.response;
    }

    const result = await markAdministratorReservationNoShow({
      actor: { id: admin.id, role: "ADMIN" },
      ipHash: hashRequestClientIp(request),
      now: new Date(),
      reason: parsed.data.reason,
      reservationId: params.id
    });
    switch (result.kind) {
      case "not_found":
        return jsonError(404, "not_found", "예약을 찾을 수 없습니다.");
      case "admin_target":
        return jsonError(403, "admin_target", "관리자 계정은 노쇼 제재 대상이 아닙니다.");
      case "not_closed":
        return jsonError(409, "not_closed", "마감된 예약만 노쇼 처리할 수 있습니다.");
      case "invalid_status":
        return jsonNoShowConflict("invalid_status", "확정 상태가 아닌 예약은 노쇼 처리할 수 없습니다.");
      case "conflict":
        return jsonNoShowConflict("conflict", "다른 요청이 예약을 먼저 처리했습니다.");
      case "ok":
        return NextResponse.json({
          cancelledFutureReservationCount: result.cancelledFutureReservationCount,
          reservation: result.reservation,
          user: result.user
        });
    }
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      return jsonError(401, "unauthorized", error.message);
    }
    if (error instanceof ForbiddenSessionError) {
      return jsonError(403, "forbidden", error.message);
    }
    return jsonError(500, "server_error", "예약 노쇼 처리 중 오류가 발생했습니다.");
  }
}

function jsonNoShowConflict(code: "conflict" | "invalid_status", message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status: 409 });
}
