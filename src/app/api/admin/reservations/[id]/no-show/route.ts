import { NextResponse } from "next/server";
import { z } from "zod";

import { canMarkReservationNoShow } from "@/lib/admin-reservation-transition";
import { prisma } from "@/lib/db";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { readJsonRequest } from "@/lib/request-json";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { hashRequestClientIp } from "@/lib/request-source";
import { buildNoShowBan } from "@/lib/reservation-service";
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
    const ipHash = hashRequestClientIp(request);

    const result = await prisma.$transaction(async (transaction) => {
      const reservation = await transaction.reservation.findUnique({ where: { id: params.id } });
      if (!reservation) {
        return { kind: "not_found" } as const;
      }
      if (!canMarkReservationNoShow(reservation.status)) {
        return { kind: "invalid_status" } as const;
      }
      const target = await transaction.user.findUnique({ where: { id: reservation.userId } });
      if (!target) {
        return { kind: "not_found" } as const;
      }
      if (target.role === "ADMIN") {
        return { kind: "admin_target" } as const;
      }

      const updatedReservation = await transaction.reservation.update({
        data: { status: "NO_SHOW" },
        where: { id: reservation.id }
      });
      const restriction = buildNoShowBan(parsed.data.reason);
      const user = await transaction.user.update({
        data: restriction,
        where: { id: reservation.userId }
      });
      const action = await transaction.adminAction.create({
        data: {
          action: "NO_SHOW_BAN",
          actorId: admin.id,
          after: JSON.stringify({
            bookingStatus: user.bookingStatus,
            reservationStatus: updatedReservation.status,
            restrictionReason: user.restrictionReason,
            restrictedUntil: user.restrictedUntil
          }),
          before: JSON.stringify({
            bookingStatus: target.bookingStatus,
            reservationStatus: reservation.status,
            restrictionReason: target.restrictionReason,
            restrictedUntil: target.restrictedUntil
          }),
          ipHash,
          reason: parsed.data.reason,
          reservationId: reservation.id,
          targetUserId: user.id
        }
      });
      await transaction.userSanction.updateMany({
        data: {
          revokedAt: new Date(),
          revokedById: admin.id,
          revokedReason: "노쇼 제재로 대체",
          status: "REVOKED"
        },
        where: {
          status: "ACTIVE",
          userId: user.id
        }
      });
      await transaction.userSanction.create({
        data: {
          actorId: admin.id,
          endsAt: null,
          reason: parsed.data.reason,
          sourceActionId: action.id,
          status: "ACTIVE",
          type: "NO_SHOW_BAN",
          userId: user.id
        }
      });
      await transaction.auditLog.create({
        data: {
          action: "NO_SHOW_BAN",
          actorId: admin.id,
          detail: JSON.stringify({ actionId: action.id, reason: parsed.data.reason, reservationId: reservation.id }),
          userId: user.id
        }
      });
      return { kind: "ok", reservation: updatedReservation, user } as const;
    });

    if (result.kind === "not_found") {
      return jsonError(404, "not_found", "예약을 찾을 수 없습니다.");
    }
    if (result.kind === "invalid_status") {
      return jsonError(409, "bad_request", "확정 상태가 아닌 예약은 노쇼 처리할 수 없습니다.");
    }
    if (result.kind === "admin_target") {
      return jsonError(403, "admin_target", "관리자 계정은 노쇼 제재 대상이 아닙니다.");
    }
    return NextResponse.json({ reservation: result.reservation, user: result.user });
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
