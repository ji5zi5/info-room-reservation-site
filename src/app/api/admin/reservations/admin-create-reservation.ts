import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  adminCreateError,
  buildAdminCreateReservationResponse,
  messageForAdminCreateReservationError,
  type AdminCreateReservationErrorReason,
  type AdminCreateReservationResult
} from "./admin-create-reservation-errors";
import { isReservableDate } from "@/lib/advance-reservation-policy";
import {
  databaseActorFromSessionUser,
  periodMutationLockKey,
  TransactionRetryExhaustedError,
  userMutationLockKey,
  withDatabaseContext,
  withDatabaseMutation
} from "@/lib/db-context";
import { prisma } from "@/lib/db";
import {
  jsonError,
  jsonMutatingRequestSafetyError,
  jsonRateLimitError,
  jsonTransactionRetryExhaustedError
} from "@/lib/http";
import { createMockAdminReservation } from "@/lib/mock-admin-reservation-create";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { getPeriodWindowState } from "@/lib/period-window";
import { periodSettingReadDates, resolveEffectivePeriodSetting } from "@/lib/period-setting-values";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { readJsonRequest } from "@/lib/request-json";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { hashRequestClientIp } from "@/lib/request-source";
import { enforceAdminMutationRateLimit } from "@/lib/route-rate-limit";
import { ForbiddenSessionError, requireAdminSession, UnauthorizedSessionError } from "@/lib/session";
import type { StudyPeriod } from "@/lib/study-periods";

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
    const databaseActor = databaseActorFromSessionUser(admin);
    const targetIdentity = await withDatabaseContext({
      actor: databaseActor,
      client: prisma,
      operation: (transaction) => transaction.user.findUnique({
        select: { id: true, role: true },
        where: { studentNumber: parsed.data.studentNumber }
      })
    });
    if (!targetIdentity) {
      return buildAdminCreateReservationResponse(adminCreateError("not_found"));
    }
    if (targetIdentity.role === "ADMIN") {
      return buildAdminCreateReservationResponse(adminCreateError("admin_target"));
    }

    const result = await withDatabaseMutation({
      actor: databaseActor,
      client: prisma,
      lockKeys: [
        periodMutationLockKey(parsed.data.date, parsed.data.studyPeriod),
        userMutationLockKey(targetIdentity.id)
      ],
      operation: async (transaction) => {
      const target = await transaction.user.findUnique({ where: { id: targetIdentity.id } });
      if (!target) {
        return adminCreateError("not_found");
      }
      if (target.role === "ADMIN") {
        return adminCreateError("admin_target");
      }

      const statusError = bookingStatusError(target.bookingStatus, target.restrictedUntil, now);
      if (statusError) {
        return adminCreateError(statusError);
      }
      if (!isReservableDate(parsed.data.date, now)) {
        return adminCreateError("advance_unavailable");
      }

      const setting = resolveEffectivePeriodSetting(
        parsed.data.date,
        parsed.data.studyPeriod,
        await transaction.periodSetting.findMany({
          where: { date: { in: [...periodSettingReadDates(parsed.data.date)] }, studyPeriod: parsed.data.studyPeriod }
        })
      );
      if (!setting.enabled) {
        return adminCreateError("disabled");
      }

      const windowState = getPeriodWindowState(setting, now);
      if (windowState !== "open") {
        return adminCreateError(windowState);
      }

      const existing = await transaction.reservation.findUnique({
        where: reservationIdentity({ date: parsed.data.date, studyPeriod: parsed.data.studyPeriod, userId: target.id })
      });
      if (existing) {
        return adminCreateError(existing.status === "CONFIRMED" ? "duplicate" : "cancelled_same_slot");
      }

      const confirmedCount = await transaction.reservation.count({
        where: { date: parsed.data.date, status: "CONFIRMED", studyPeriod: parsed.data.studyPeriod }
      });
      if (confirmedCount >= setting.capacity) {
        return adminCreateError("full");
      }

      const reservation = await transaction.reservation.create({
        data: {
          date: parsed.data.date,
          reason: parsed.data.reason,
          status: "CONFIRMED",
          studyPeriod: parsed.data.studyPeriod,
          userId: target.id
        }
      });
      const action = await transaction.adminAction.create({
        data: {
          action: "ADMIN_RESERVATION_CREATE",
          actorId: admin.id,
          after: JSON.stringify({
            date: reservation.date,
            reservationStatus: reservation.status,
            studyPeriod: reservation.studyPeriod
          }),
          before: null,
          ipHash,
          reason: parsed.data.reason,
          reservationId: reservation.id,
          targetUserId: target.id
        }
      });
      await transaction.auditLog.create({
        data: {
          action: "ADMIN_RESERVATION_CREATE",
          actorId: admin.id,
          detail: JSON.stringify({
            actionId: action.id,
            date: reservation.date,
            reason: parsed.data.reason,
            reservationId: reservation.id,
            studyPeriod: reservation.studyPeriod
          }),
          userId: target.id
        }
      });
      return { kind: "confirmed", reservation } satisfies AdminCreateReservationResult;
      }
    });

    return buildAdminCreateReservationResponse(result);
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      return jsonError(401, "unauthorized", error.message);
    }
    if (error instanceof ForbiddenSessionError) {
      return jsonError(403, "forbidden", error.message);
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return jsonError(409, "duplicate", messageForAdminCreateReservationError("duplicate"));
    }
    if (error instanceof TransactionRetryExhaustedError) {
      return jsonTransactionRetryExhaustedError();
    }
    throw error;
  }
}

function bookingStatusError(
  bookingStatus: string,
  restrictedUntil: Date | null,
  now: Date
): AdminCreateReservationErrorReason | null {
  switch (bookingStatus) {
    case "ACTIVE":
      return null;
    case "BANNED":
      return "restricted";
    case "RESTRICTED":
      return restrictedUntil === null || restrictedUntil.getTime() > now.getTime() ? "restricted" : null;
    case "SHADOW_BANNED":
      return "shadow_banned";
    default:
      return "restricted";
  }
}

function reservationIdentity(input: {
  readonly date: string;
  readonly studyPeriod: StudyPeriod;
  readonly userId: string;
}): { readonly userId_date_studyPeriod: { readonly date: string; readonly studyPeriod: StudyPeriod; readonly userId: string } } {
  return { userId_date_studyPeriod: { date: input.date, studyPeriod: input.studyPeriod, userId: input.userId } };
}
