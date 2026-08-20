import { NextResponse } from "next/server";
import { z } from "zod";

import { cancelAdministratorReservation } from "@/lib/admin-reservation-operations";
import { scheduleDiscordOperationsBoardSync } from "@/lib/discord-operations-board-after-mutation";
import {
  isSerializableTransactionConflict,
  TransactionRetryExhaustedError
} from "@/lib/db-context";
import {
  jsonError,
  jsonMutatingRequestSafetyError,
  jsonRateLimitError
} from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { cancelMockReservation } from "@/lib/mock-reservation-data";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { readJsonRequest } from "@/lib/request-json";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { hashRequestClientIp } from "@/lib/request-source";
import { enforceAdminMutationRateLimit } from "@/lib/route-rate-limit";
import { requireAdminSession, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

const AdminCancelReservationRequestSchema = z.object({
  reason: z.string().trim().min(1).max(200)
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
      message: "관리자 취소 사유를 입력하세요.",
      schema: AdminCancelReservationRequestSchema
    });
    if (parsed.kind === "error") {
      return parsed.response;
    }
    if (isNoDatabaseMockMode()) {
      const result = cancelMockReservation({ id: params.id, now: new Date(), requireConfirmed: true, user: admin });
      if (result.kind === "not_found") {
        return jsonError(404, "not_found", "예약을 찾을 수 없습니다.");
      }
      if (result.kind === "not_cancellable") {
        return jsonError(409, "bad_request", "이미 처리된 예약은 관리자 취소로 변경할 수 없습니다.");
      }
      if (result.kind === "forbidden") {
        return jsonError(403, "forbidden", "예약을 취소할 권한이 없습니다.");
      }
      return NextResponse.json({ reservation: result.reservation });
    }
    const ipHash = hashRequestClientIp(request);
    const result = await cancelAdministratorReservation({
      actor: { id: admin.id, role: "ADMIN" },
      ipHash,
      reason: parsed.data.reason,
      reservationId: params.id,
      source: { kind: "WEB_ADMIN" }
    });
    if (result.kind === "not_found") {
      return jsonError(404, "not_found", "예약을 찾을 수 없습니다.");
    }
    if (result.kind === "invalid_status") {
      return jsonError(409, "bad_request", "이미 처리된 예약은 관리자 취소로 변경할 수 없습니다.");
    }
    scheduleDiscordOperationsBoardSync();
    return NextResponse.json({ reservation: result.reservation });
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      return jsonError(401, "unauthorized", error.message);
    }
    if (error instanceof ForbiddenSessionError) {
      return jsonError(403, "forbidden", error.message);
    }
    if (error instanceof TransactionRetryExhaustedError && isSerializableTransactionConflict(error.cause)) {
      return jsonError(409, "bad_request", "이미 처리된 예약은 관리자 취소로 변경할 수 없습니다.");
    }
    return jsonError(500, "server_error", "관리자 예약 취소 처리 중 오류가 발생했습니다.");
  }
}
