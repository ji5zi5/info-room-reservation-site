import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { hashRequestClientIp } from "@/lib/request-source";
import { buildStudentCancellationRestriction } from "@/lib/reservation-service";
import { enforceReservationRateLimit } from "@/lib/route-rate-limit";
import { requireSession, UnauthorizedSessionError } from "@/lib/session";

export async function DELETE(request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<NextResponse> {
  const requestSafetyError = requireMutatingRequestSafety(request);
  if (requestSafetyError) {
    return jsonMutatingRequestSafetyError(requestSafetyError);
  }

  try {
    const session = await requireSession();
    const csrfResult = await validateRequestCsrf(request, session.id);
    if (csrfResult.kind === "error") {
      return jsonError(403, csrfResult.reason, messageForCsrfError(csrfResult.reason));
    }
    const user = session.user;
    const rateLimitResult = await enforceReservationRateLimit(request, user.id);
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
      if (reservation.userId !== user.id && user.role !== "ADMIN") {
        return { kind: "forbidden" } as const;
      }
      if (reservation.status === "CANCELLED") {
        return { kind: "cancelled", reservation } as const;
      }

      const updated = await transaction.reservation.update({
        data: { status: "CANCELLED" },
        where: { id: reservation.id }
      });

      if (reservation.userId === user.id && user.role !== "ADMIN") {
        const restriction = buildStudentCancellationRestriction(new Date());
        const updatedUser = await transaction.user.update({
          data: restriction,
          where: { id: user.id }
        });
        const action = await transaction.adminAction.create({
          data: {
            action: "STUDENT_RESERVATION_CANCEL_RESTRICTION",
            actorId: user.id,
            after: JSON.stringify({
              bookingStatus: updatedUser.bookingStatus,
              reservationStatus: updated.status,
              restrictionReason: updatedUser.restrictionReason,
              restrictedUntil: updatedUser.restrictedUntil
            }),
            before: JSON.stringify({ reservationStatus: reservation.status }),
            ipHash,
            reason: updatedUser.restrictionReason,
            reservationId: reservation.id,
            targetUserId: user.id
          }
        });
        await transaction.userSanction.create({
          data: {
            actorId: user.id,
            endsAt: restriction.restrictedUntil,
            reason: updatedUser.restrictionReason ?? "예약 취소 제한",
            sourceActionId: action.id,
            status: "ACTIVE",
            type: "CANCELLATION_RESTRICTION",
            userId: user.id
          }
        });
        await transaction.auditLog.create({
          data: {
            action: "STUDENT_RESERVATION_CANCEL_RESTRICTION",
            actorId: user.id,
            detail: JSON.stringify({ actionId: action.id, reservationId: reservation.id, restrictedUntil: restriction.restrictedUntil }),
            userId: user.id
          }
        });
      }

      return { kind: "cancelled", reservation: updated } as const;
    });

    if (result.kind === "not_found") {
      return jsonError(404, "not_found", "예약을 찾을 수 없습니다.");
    }
    if (result.kind === "forbidden") {
      return jsonError(403, "forbidden", "예약을 취소할 권한이 없습니다.");
    }
    return NextResponse.json({ reservation: result.reservation });
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      return jsonError(401, "unauthorized", error.message);
    }
    throw error;
  }
}
