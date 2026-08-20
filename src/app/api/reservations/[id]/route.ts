import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import {
  databaseActorFromSessionUser,
  TransactionRetryExhaustedError,
  userMutationLockKey,
  withDatabaseMutation
} from "@/lib/db-context";
import { prisma } from "@/lib/db";
import { scheduleDiscordOperationsBoardSync } from "@/lib/discord-operations-board-after-mutation";
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
import { enforceReservationRateLimit } from "@/lib/route-rate-limit";
import { createMockSessionToken, requireSession, setSessionCookie, UnauthorizedSessionError } from "@/lib/session";
import { maskStudentFacingSessionUser } from "@/lib/student-facing-session";

type StudentCancellationCapabilityOutcome = "CANCELLED" | "FORBIDDEN" | "NOT_CANCELLABLE" | "NOT_FOUND";

type StudentCancellationCapabilityRow = {
  readonly outcome: string;
};

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
        const rows = await transaction.$queryRaw<readonly StudentCancellationCapabilityRow[]>`
          SELECT app_private.cancel_owned_student_reservation(
            ${params.id},
            ${ipHash},
            ${randomUUID()},
            ${randomUUID()},
            ${randomUUID()}
          ) AS outcome
        `;
        const outcome = parseStudentCancellationCapabilityOutcome(rows[0]?.outcome);
        if (outcome === "NOT_FOUND") {
          return { kind: "not_found" } as const;
        }
        if (outcome === "FORBIDDEN") {
          return { kind: "forbidden" } as const;
        }
        if (outcome === "NOT_CANCELLABLE") {
          return { kind: "not_cancellable" } as const;
        }
        const reservation = await transaction.reservation.findUnique({ where: { id: params.id } });
        if (!reservation) {
          throw new InvalidStudentCancellationCapabilityResultError("cancelled reservation was not visible to its actor");
        }
        return { kind: "cancelled", reservation } as const;
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
    scheduleDiscordOperationsBoardSync();
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

function parseStudentCancellationCapabilityOutcome(value: string | undefined): StudentCancellationCapabilityOutcome {
  switch (value) {
    case "CANCELLED":
    case "FORBIDDEN":
    case "NOT_CANCELLABLE":
    case "NOT_FOUND":
      return value;
    default:
      throw new InvalidStudentCancellationCapabilityResultError(value ?? "missing outcome");
  }
}

class InvalidStudentCancellationCapabilityResultError extends Error {
  public constructor(detail: string) {
    super(`Invalid student cancellation capability result: ${detail}`);
    this.name = "InvalidStudentCancellationCapabilityResultError";
  }
}
