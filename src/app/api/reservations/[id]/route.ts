import { NextResponse } from "next/server";

import {
  databaseActorFromSessionUser,
  TransactionRetryExhaustedError,
  userMutationLockKey,
  withDatabaseMutation
} from "@/lib/db-context";
import { prisma } from "@/lib/db";
import {
  jsonError,
  jsonMutatingRequestSafetyError,
  jsonRateLimitError,
  jsonTransactionRetryExhaustedError
} from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { cancelMockReservation } from "@/lib/mock-reservation-data";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { hashRequestClientIp } from "@/lib/request-source";
import { buildStudentCancellationRestriction } from "@/lib/reservation-service";
import { enforceReservationRateLimit } from "@/lib/route-rate-limit";
import { createMockSessionToken, requireSession, setSessionCookie, UnauthorizedSessionError } from "@/lib/session";
import { maskStudentFacingSessionUser } from "@/lib/student-facing-session";

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
    if (user.role === "ADMIN") {
      return jsonError(403, "forbidden", "예약을 취소할 권한이 없습니다.");
    }
    const params = await context.params;
    if (isNoDatabaseMockMode()) {
      const result = cancelMockReservation({ id: params.id, now: new Date(), user });
      if (result.kind === "not_found") {
        return jsonError(404, "not_found", "예약을 찾을 수 없습니다.");
      }
      if (result.kind === "forbidden") {
        return jsonError(403, "forbidden", "예약을 취소할 권한이 없습니다.");
      }
      const { date, id, reason, status, studyPeriod, userId } = result.reservation;
      const publicUser = maskStudentFacingSessionUser(result.user) ?? result.user;
      const response = NextResponse.json({
        reservation: { date, id, reason, status, studyPeriod, userId },
        user: publicUser
      });
      response.headers.set("Cache-Control", "no-store");
      setSessionCookie(response, createMockSessionToken(publicUser));
      return response;
    }

    const ipHash = hashRequestClientIp(request);
    const result = await withDatabaseMutation({
      actor: databaseActorFromSessionUser(user),
      client: prisma,
      lockKeys: [userMutationLockKey(user.id)],
      operation: async (transaction) => {
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
      if (reservation.status !== "CONFIRMED") {
        return { kind: "not_cancellable" } as const;
      }

      const transition = await transaction.reservation.updateMany({
        data: { status: "CANCELLED" },
        where: { id: reservation.id, status: "CONFIRMED" }
      });
      if (transition.count !== 1) {
        return { kind: "not_cancellable" } as const;
      }
      const updated = { ...reservation, status: "CANCELLED" } as const;

      if (reservation.userId === user.id && user.role !== "ADMIN" && user.bookingStatus !== "SHADOW_BANNED") {
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
        await transaction.userSanction.updateMany({
          data: {
            revokedAt: new Date(),
            revokedById: user.id,
            revokedReason: "새 예약 취소 제한으로 대체",
            status: "REVOKED"
          },
          where: {
            status: "ACTIVE",
            type: "CANCELLATION_RESTRICTION",
            userId: user.id
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
      }
    });

    if (result.kind === "not_found") {
      return jsonError(404, "not_found", "예약을 찾을 수 없습니다.");
    }
    if (result.kind === "forbidden") {
      return jsonError(403, "forbidden", "예약을 취소할 권한이 없습니다.");
    }
    if (result.kind === "not_cancellable") {
      return jsonError(409, "bad_request", "이미 처리된 예약은 취소할 수 없습니다.");
    }
    return NextResponse.json({ reservation: result.reservation });
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      return jsonError(401, "unauthorized", error.message);
    }
    if (error instanceof TransactionRetryExhaustedError) {
      return jsonTransactionRetryExhaustedError();
    }
    throw error;
  }
}
