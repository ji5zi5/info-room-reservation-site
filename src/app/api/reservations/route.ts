import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import { isReservableDate } from "@/lib/advance-reservation-policy";
import { databaseActorFromSessionUser } from "@/lib/db-context";
import { reserveStudyPeriod } from "@/lib/reservation-service";
import { createPrismaReservationStoreForActor } from "@/lib/prisma-reservation-store";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
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

    const result = await reserveStudyPeriod({
      date: parsed.data.date,
      now,
      reason: parsed.data.reason,
      store: createPrismaReservationStoreForActor(databaseActorFromSessionUser(user)),
      studyPeriod: parsed.data.studyPeriod,
      userId: user.id
    });

    return buildReservationResponse(result);
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      return jsonError(401, "unauthorized", error.message);
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return jsonError(409, "duplicate", "이미 예약한 시간대입니다.");
    }
    throw error;
  }
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
      return 403;
    case "closed":
    case "disabled":
    case "duplicate":
    case "full":
    case "not_open_yet":
      return 409;
    case "not_found":
      return 404;
    case "shadow_banned":
      return 500; // Fallback, shouldn't be reached due to intercept
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
      return "서버 내부 오류가 발생했습니다."; // Fallback
  }
}

function buildReservationResponse(result: import("@/lib/reservation-service").ReservationResult): NextResponse {
  if (result.kind === "confirmed") {
    return NextResponse.json({ reservation: result.reservation }, { status: 201 });
  }

  if (result.reason === "shadow_banned") {
    const fakeErrors = [
      { status: 429, error: "rate_limited" as const, message: "일시적인 요청 과부하입니다. 잠시 후 다시 시도해주세요." },
      { status: 500, error: "server_error" as const, message: "서버 내부 오류가 발생했습니다." },
      { status: 502, error: "server_error" as const, message: "예약 서버와의 통신에 실패했습니다." }
    ];
    const randomError = fakeErrors[Math.floor(Math.random() * fakeErrors.length)]!;
    return jsonError(randomError.status, randomError.error, randomError.message);
  }

  return jsonError(statusForReservationError(result.reason), result.reason, messageForReservationError(result.reason));
}

