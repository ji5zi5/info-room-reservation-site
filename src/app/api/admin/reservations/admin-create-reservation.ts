import { NextResponse } from "next/server";
import { z } from "zod";

import {
  adminCreateError,
  buildAdminCreateReservationResponse
} from "./admin-create-reservation-errors";
import { createAdministratorReservation } from "@/lib/admin-reservation-create-service";
import { TransactionRetryExhaustedError } from "@/lib/db-context";
import { scheduleDiscordOperationsBoardSync } from "@/lib/discord-operations-board-after-mutation";
import {
  jsonError,
  jsonMutatingRequestSafetyError,
  jsonRateLimitError,
  jsonTransactionRetryExhaustedError
} from "@/lib/http";
import { createMockAdminReservation } from "@/lib/mock-admin-reservation-create";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { readJsonRequest } from "@/lib/request-json";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { hashRequestClientIp } from "@/lib/request-source";
import { enforceAdminMutationRateLimit } from "@/lib/route-rate-limit";
import { ForbiddenSessionError, requireAdminSession, UnauthorizedSessionError } from "@/lib/session";

const AdminCreateReservationRequestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  reason: z.string().trim().min(1).max(80),
  studentNumber: z.string().trim().min(1).max(40),
  studyPeriod: z.union([z.literal("EIGHTH"), z.literal("FIRST")])
});

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

    const admin = session.user;
    const rateLimitResult = await enforceAdminMutationRateLimit(request, admin.id);
    if (rateLimitResult.kind === "blocked") {
      return jsonRateLimitError(rateLimitResult);
    }

    const parsed = await readJsonRequest(request, {
      message: "학생 예약 추가 요청 형식이 올바르지 않습니다.",
      schema: AdminCreateReservationRequestSchema
    });
    if (parsed.kind === "error") {
      return parsed.response;
    }

    const now = new Date();
    if (isNoDatabaseMockMode()) {
      return buildAdminCreateReservationResponse(createMockAdminReservation({ ...parsed.data, now }));
    }

    const ipHash = hashRequestClientIp(request);
    const result = await createAdministratorReservation({
      actor: { id: admin.id, role: "ADMIN" },
      date: parsed.data.date,
      ipHash,
      now,
      reason: parsed.data.reason,
      studentNumber: parsed.data.studentNumber,
      studyPeriod: parsed.data.studyPeriod
    });
    if (result.kind === "confirmed") scheduleDiscordOperationsBoardSync();
    return buildAdminCreateReservationResponse(
      result.kind === "confirmed" ? result : adminCreateError(result.kind)
    );
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      return jsonError(401, "unauthorized", error.message);
    }
    if (error instanceof ForbiddenSessionError) {
      return jsonError(403, "forbidden", error.message);
    }
    if (error instanceof TransactionRetryExhaustedError) {
      return jsonTransactionRetryExhaustedError();
    }
    throw error;
  }
}
