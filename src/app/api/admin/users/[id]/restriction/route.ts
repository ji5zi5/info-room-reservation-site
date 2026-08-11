import { NextResponse } from "next/server";
import { z } from "zod";

import { assertRestrictableUser } from "@/lib/admin-users";
import { selectCancellableConfirmedReservationIds } from "@/lib/admin-cancellable-reservations";
import {
  databaseActorFromSessionUser,
  isSerializableTransactionConflict,
  TransactionRetryExhaustedError,
  userMutationLockKey,
  withDatabaseMutation
} from "@/lib/db-context";
import { prisma } from "@/lib/db";
import { toKstDate } from "@/lib/date";
import { jsonError, jsonTransactionRetryExhaustedError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { applyMockUserRestriction, removeMockUserRestriction, type MockUserRestrictionResult } from "@/lib/mock-user-restrictions";
import { periodSettingReadDates } from "@/lib/period-setting-values";
import { readJsonRequest } from "@/lib/request-json";
import { hashRequestClientIp } from "@/lib/request-source";
import { DEFAULT_SHADOW_BAN_PROFILE, parseShadowBanProfile } from "@/lib/shadow-ban-profile";

import {
  adminSessionErrorResponse,
  prepareAdminRestrictionMutation,
  stringifyRestrictionSnapshot
} from "./restriction-route-support";

const RestrictionRequestSchema = z.object({
  days: z.number().int().min(1).max(365).nullable().optional(),
  reason: z.string().trim().min(1).max(200),
  shadowBanProfile: z.union([z.literal("LOW"), z.literal("NORMAL"), z.literal("HIGH")]).optional(),
  status: z.union([z.literal("RESTRICTED"), z.literal("BANNED"), z.literal("SHADOW_BANNED")])
});
type RestrictionStatus = z.infer<typeof RestrictionRequestSchema>["status"];

export async function POST(request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<NextResponse> {
  try {
    const admin = await prepareAdminRestrictionMutation(request);
    if (admin instanceof NextResponse) {
      return admin;
    }
    const params = await context.params;
    const parsed = await readJsonRequest(request, {
      message: "사용자 제한 요청 형식이 올바르지 않습니다.",
      schema: RestrictionRequestSchema
    });
    if (parsed.kind === "error") {
      return parsed.response;
    }
    const restrictionDays = parsed.data.days ?? null;
    const shadowBanProfile =
      parsed.data.status === "SHADOW_BANNED" ? parseShadowBanProfile(parsed.data.shadowBanProfile) : DEFAULT_SHADOW_BAN_PROFILE;
    const now = new Date();

    let restrictedUntil: Date | null = null;
    if ((parsed.data.status === "BANNED" || parsed.data.status === "SHADOW_BANNED") && restrictionDays !== null) {
      return jsonError(400, "bad_request", "영구 차단에는 기간을 설정할 수 없습니다.");
    }
    if (parsed.data.status === "RESTRICTED") {
      if (restrictionDays === null) {
        return jsonError(400, "bad_request", "기간 제한 일수가 필요합니다.");
      }
      restrictedUntil = new Date(now.getTime() + restrictionDays * 24 * 60 * 60 * 1000);
    }
    if (isNoDatabaseMockMode()) {
      return mockRestrictionResultResponse(
        applyMockUserRestriction({
          actorId: admin.id,
          bookingStatus: parsed.data.status,
          now,
          restrictedUntil,
          restrictionReason: parsed.data.reason,
          shadowBanProfile,
          targetUserId: params.id
        })
      );
    }
    const ipHash = hashRequestClientIp(request);

    const result = await withDatabaseMutation({
      actor: databaseActorFromSessionUser(admin),
      client: prisma,
      lockKeys: [userMutationLockKey(params.id)],
      operation: async (transaction) => {
      const target = await transaction.user.findUnique({ where: { id: params.id } });
      if (!target) {
        return { kind: "not_found" } as const;
      }
      const guard = assertRestrictableUser({ actorId: admin.id, target });
      if (guard.kind === "error") {
        return { kind: "forbidden", reason: guard.reason } as const;
      }
      if (target.bookingStatus === "BANNED" && parsed.data.status !== "BANNED") {
        return { kind: "weaker_status" } as const;
      }
      if (
        target.bookingStatus === "BANNED" &&
        parsed.data.status === "BANNED" &&
        target.restrictionReason === parsed.data.reason
      ) {
        return { cancelledFutureReservationCount: 0, idempotent: true, kind: "ok", user: target } as const;
      }
      const updated = await transaction.user.update({
        data: {
          bookingStatus: parsed.data.status,
          restrictedUntil,
          restrictionReason: parsed.data.reason,
          shadowBanProfile
        },
        where: { id: params.id }
      });
      const today = toKstDate(now);
      let cancelledFutureReservationCount = 0;
      if (shouldCancelFutureReservations(parsed.data.status)) {
        const candidates = await transaction.reservation.findMany({
          where: { date: { gte: today }, status: "CONFIRMED", userId: params.id }
        });
        const settings = await transaction.periodSetting.findMany({
          where: { date: { in: [...periodSettingReadDates(today)] } }
        });
        const cancellableReservationIds = selectCancellableConfirmedReservationIds({ now, reservations: candidates, settings });
        if (cancellableReservationIds.length > 0) {
          cancelledFutureReservationCount = (
            await transaction.reservation.updateMany({
              data: { status: "CANCELLED" },
              where: { id: { in: [...cancellableReservationIds] }, status: "CONFIRMED" }
            })
          ).count;
        }
      }
      const action = await transaction.adminAction.create({
        data: {
          action: "USER_RESTRICTION_APPLY",
          actorId: admin.id,
          after: JSON.stringify({
            bookingStatus: updated.bookingStatus,
            ...(parsed.data.status === "BANNED" ? { cancelledFutureReservationCount } : {}),
            restrictedUntil: updated.restrictedUntil,
            restrictionReason: updated.restrictionReason,
            shadowBanProfile: updated.shadowBanProfile
          }),
          before: stringifyRestrictionSnapshot(target),
          ipHash,
          reason: parsed.data.reason,
          targetUserId: params.id
        }
      });
      await transaction.userSanction.updateMany({
        data: {
          revokedAt: new Date(),
          revokedById: admin.id,
          revokedReason: "새 관리자 제재로 대체",
          status: "REVOKED"
        },
        where: {
          status: "ACTIVE",
          userId: params.id
        }
      });
      await transaction.userSanction.create({
        data: {
          actorId: admin.id,
          endsAt: restrictedUntil,
          reason: parsed.data.reason,
          sourceActionId: action.id,
          status: "ACTIVE",
          type: parsed.data.status === "BANNED" || parsed.data.status === "SHADOW_BANNED" ? "ADMIN_BAN" : "ADMIN_RESTRICTION",
          userId: params.id
        }
      });
      await transaction.auditLog.create({
        data: {
          action: "USER_RESTRICTION_APPLY",
          actorId: admin.id,
          detail: JSON.stringify({
            cancelledFutureReservationCount,
            days: restrictionDays,
            reason: parsed.data.reason,
            restrictedUntil,
            shadowBanProfile,
            status: parsed.data.status
          }),
          userId: params.id
        }
      });
      return { cancelledFutureReservationCount, kind: "ok", user: updated } as const;
      }
    });

    if (result.kind === "not_found") {
      return jsonError(404, "not_found", "사용자를 찾을 수 없습니다.");
    }
    if (result.kind === "forbidden") {
      return jsonError(
        403,
        result.reason,
        result.reason === "self_restriction" ? "자기 자신은 제한할 수 없습니다." : "관리자 계정은 제한할 수 없습니다."
      );
    }
    if (result.kind === "weaker_status") {
      return jsonError(409, "bad_request", "영구 차단 상태는 먼저 해제해야 합니다.");
    }

    return NextResponse.json({
      cancelledFutureReservationCount: result.cancelledFutureReservationCount,
      ...(result.idempotent ? { idempotent: true } : {}),
      user: result.user
    });
  } catch (error) {
    if (error instanceof TransactionRetryExhaustedError && isSerializableTransactionConflict(error.cause)) {
      return jsonError(409, "bad_request", "동시에 처리된 사용자 제재 요청입니다. 현재 상태를 다시 확인해 주세요.");
    }
    const response = adminSessionErrorResponse(error);
    if (response) {
      return response;
    }
    return jsonError(500, "server_error", "사용자 제재 처리 중 오류가 발생했습니다.");
  }
}

export async function DELETE(request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<NextResponse> {
  try {
    const admin = await prepareAdminRestrictionMutation(request);
    if (admin instanceof NextResponse) {
      return admin;
    }
    const params = await context.params;
    if (isNoDatabaseMockMode()) {
      return mockRestrictionResultResponse(removeMockUserRestriction({ actorId: admin.id, targetUserId: params.id }));
    }
    const ipHash = hashRequestClientIp(request);

    const result = await withDatabaseMutation({
      actor: databaseActorFromSessionUser(admin),
      client: prisma,
      lockKeys: [userMutationLockKey(params.id)],
      operation: async (transaction) => {
      const target = await transaction.user.findUnique({ where: { id: params.id } });
      if (!target) {
        return { kind: "not_found" } as const;
      }
      const guard = assertRestrictableUser({ actorId: admin.id, target });
      if (guard.kind === "error") {
        return { kind: "forbidden", reason: guard.reason } as const;
      }
      const updated = await transaction.user.update({
        data: {
          bookingStatus: "ACTIVE",
          restrictedUntil: null,
          restrictionReason: null,
          shadowBanProfile: DEFAULT_SHADOW_BAN_PROFILE
        },
        where: { id: params.id }
      });
      const action = await transaction.adminAction.create({
        data: {
          action: "USER_RESTRICTION_REMOVE",
          actorId: admin.id,
          after: stringifyRestrictionSnapshot(updated),
          before: stringifyRestrictionSnapshot(target),
          ipHash,
          reason: "관리자 제한 해제",
          targetUserId: params.id
        }
      });
      await transaction.userSanction.updateMany({
        data: {
          revokedAt: new Date(),
          revokedById: admin.id,
          revokedReason: "관리자 제한 해제",
          status: "REVOKED"
        },
        where: {
          status: "ACTIVE",
          userId: params.id
        }
      });
      await transaction.auditLog.create({
        data: {
          action: "USER_RESTRICTION_REMOVE",
          actorId: admin.id,
          detail: JSON.stringify({ actionId: action.id }),
          userId: params.id
        }
      });
      return { kind: "ok", user: updated } as const;
      }
    });
    if (result.kind === "not_found") {
      return jsonError(404, "not_found", "사용자를 찾을 수 없습니다.");
    }
    if (result.kind === "forbidden") {
      return jsonError(
        403,
        result.reason,
        result.reason === "self_restriction" ? "자기 자신은 제한할 수 없습니다." : "관리자 계정은 제한할 수 없습니다."
      );
    }
    return NextResponse.json({ user: result.user });
  } catch (error) {
    if (error instanceof TransactionRetryExhaustedError) {
      return jsonTransactionRetryExhaustedError();
    }
    const response = adminSessionErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
}

function shouldCancelFutureReservations(status: RestrictionStatus): boolean {
  return status === "BANNED";
}

function mockRestrictionResultResponse(result: MockUserRestrictionResult): NextResponse {
  switch (result.kind) {
    case "ok":
      return NextResponse.json({
        cancelledFutureReservationCount: result.cancelledFutureReservationCount,
        ...(result.idempotent ? { idempotent: true } : {}),
        user: result.user
      });
    case "not_found":
      return jsonError(404, "not_found", "사용자를 찾을 수 없습니다.");
    case "forbidden":
      return jsonError(
        403,
        result.reason,
        result.reason === "self_restriction" ? "자기 자신은 제한할 수 없습니다." : "관리자 계정은 제한할 수 없습니다."
      );
  }
}
