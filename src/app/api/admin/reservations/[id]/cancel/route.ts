import { NextResponse } from "next/server";

import { canAdminCancelReservation } from "@/lib/admin-reservation-transition";
import { prisma } from "@/lib/db";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { hashRequestClientIp } from "@/lib/request-source";
import { enforceAdminMutationRateLimit } from "@/lib/route-rate-limit";
import { requireAdminSession, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

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
    const ipHash = hashRequestClientIp(request);
    const result = await prisma.$transaction(async (transaction) => {
      const reservation = await transaction.reservation.findUnique({ where: { id: params.id } });
      if (!reservation) {
        return { kind: "not_found" } as const;
      }
      if (!canAdminCancelReservation(reservation.status)) {
        return { kind: "invalid_status" } as const;
      }
      const updated = await transaction.reservation.update({
        data: { status: "CANCELLED" },
        where: { id: reservation.id }
      });
      const action = await transaction.adminAction.create({
        data: {
          action: "ADMIN_RESERVATION_CANCEL",
          actorId: admin.id,
          after: JSON.stringify({ reservationStatus: updated.status }),
          before: JSON.stringify({ reservationStatus: reservation.status }),
          ipHash,
          reservationId: reservation.id,
          targetUserId: reservation.userId
        }
      });
      await transaction.auditLog.create({
        data: {
          action: "ADMIN_RESERVATION_CANCEL",
          actorId: admin.id,
          detail: JSON.stringify({ actionId: action.id, reservationId: reservation.id }),
          userId: reservation.userId
        }
      });
      return { kind: "ok", reservation: updated } as const;
    });
    if (result.kind === "not_found") {
      return jsonError(404, "not_found", "예약을 찾을 수 없습니다.");
    }
    if (result.kind === "invalid_status") {
      return jsonError(409, "bad_request", "이미 처리된 예약은 관리자 취소로 변경할 수 없습니다.");
    }
    return NextResponse.json({ reservation: result.reservation });
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      return jsonError(401, "unauthorized", error.message);
    }
    if (error instanceof ForbiddenSessionError) {
      return jsonError(403, "forbidden", error.message);
    }
    throw error;
  }
}
