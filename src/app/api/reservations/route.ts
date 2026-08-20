import { Prisma } from "@prisma/client";
import { after } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { isReservableDate } from "@/lib/advance-reservation-policy";
import { databaseActorFromSessionUser, TransactionRetryExhaustedError } from "@/lib/db-context";
import { runDiscordReservationOutbox } from "@/lib/discord-reservation-outbox";
import { syncDiscordOperationsBoardAfterMutation } from "@/lib/discord-operations-board-after-mutation";
import { reserveStudyPeriod } from "@/lib/reservation-service";
import { createPrismaReservationStoreForActor } from "@/lib/prisma-reservation-store";
import {
  jsonError,
  jsonMutatingRequestSafetyError,
  jsonRateLimitError,
  jsonTransactionRetryExhaustedError
} from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { reserveMockStudyPeriod } from "@/lib/mock-reservation-data";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { readJsonRequest } from "@/lib/request-json";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { enforceReservationRateLimit } from "@/lib/route-rate-limit";
import { requireSession, UnauthorizedSessionError } from "@/lib/session";

const ReservationRequestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  reason: z.string().trim().min(1).max(80),
  studyPeriod: z.union([z.literal("EIGHTH"), z.literal("FIRST")])
});

export async function POST(request: Request): Promise<NextResponse> {
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
    if (user.role === "ADMIN") {
      return jsonError(403, "admin_not_reservable", "관리자 계정은 예약할 수 없습니다.");
    }
    const rateLimitResult = await enforceReservationRateLimit(request, user.id);
    if (rateLimitResult.kind === "blocked") {
      return jsonRateLimitError(rateLimitResult);
    }

    const parsed = await readJsonRequest(request, {
      message: "예약 요청 형식이 올바르지 않습니다.",
      schema: ReservationRequestSchema
    });
    if (parsed.kind === "error") {
      return parsed.response;
    }

    const now = new Date();
    if (!isReservableDate(parsed.data.date, now)) {
      return jsonError(409, "advance_unavailable", "사전예약 불가");
    }

    if (isNoDatabaseMockMode()) {
      const result = reserveMockStudyPeriod({
        date: parsed.data.date,
        now,
        reason: parsed.data.reason,
        studyPeriod: parsed.data.studyPeriod,
        user
      });
      return buildReservationResponse(result);
    }

    const store = createPrismaReservationStoreForActor(databaseActorFromSessionUser(user));
    const result = await reserveStudyPeriod({
      date: parsed.data.date,
      now,
      reason: parsed.data.reason,
      store,
      studyPeriod: parsed.data.studyPeriod,
      userId: user.id
    });
    if (result.kind === "confirmed") {
      after(async () => {
        try {
          await runDiscordReservationOutbox({ now: new Date(), reservationId: result.reservation.id });
        } catch (error) {
          reportReservationOutboxFailure(result.reservation.id, error);
        }
        await syncDiscordOperationsBoardAfterMutation();
      });
    }

    return buildReservationResponse(result);
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      return jsonError(401, "unauthorized", error.message);
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return jsonError(409, "duplicate", "이미 예약한 시간대입니다.");
    }
    if (error instanceof TransactionRetryExhaustedError) {
      return jsonTransactionRetryExhaustedError();
    }
    throw error;
  }
}

function reportReservationOutboxFailure(reservationId: string, _error: unknown): void {
  console.error(
    JSON.stringify({
      event: "discord_reservation_outbox_trigger_failed",
      reservationId
    })
  );
}

type ReservationErrorReason =
  | "advance_unavailable"
  | "admin_not_reservable"
  | "closed"
  | "disabled"
  | "duplicate"
  | "full"
  | "not_found"
  | "not_open_yet"
  | "restricted"
  | "shadow_banned";

function statusForReservationError(reason: ReservationErrorReason): number {
  switch (reason) {
    case "advance_unavailable":
      return 409;
    case "admin_not_reservable":
    case "restricted":
    case "shadow_banned":
      return 403;
    case "closed":
    case "disabled":
    case "duplicate":
    case "full":
    case "not_open_yet":
      return 409;
    case "not_found":
      return 404;
  }
}

function messageForReservationError(reason: ReservationErrorReason): string {
  switch (reason) {
    case "advance_unavailable":
      return "사전예약 불가";
    case "admin_not_reservable":
      return "관리자 계정은 예약할 수 없습니다.";
    case "closed":
      return "예약 시간이 마감되었습니다.";
    case "disabled":
      return "예약이 비활성화된 시간대입니다.";
    case "duplicate":
      return "이미 예약한 시간대입니다.";
    case "full":
      return "정원이 마감되었습니다.";
    case "not_found":
      return "예약 시간대를 찾을 수 없습니다.";
    case "not_open_yet":
      return "아직 예약이 열리지 않았습니다.";
    case "restricted":
      return "예약 이용이 제한되었습니다.";
    case "shadow_banned":
      return "예약을 처리할 수 없습니다.";
  }
}

async function buildReservationResponse(result: import("@/lib/reservation-service").ReservationResult): Promise<NextResponse> {
  if (result.kind === "confirmed") {
    return NextResponse.json({ reservation: result.reservation }, { status: 201 });
  }

  if (result.reason === "shadow_banned") {
    return jsonError(403, "reservation_unavailable", messageForReservationError(result.reason));
  }

  return jsonError(statusForReservationError(result.reason), result.reason, messageForReservationError(result.reason));
}
