import { NextResponse } from "next/server";
import { z } from "zod";

import { assertRestrictableUser } from "@/lib/admin-users";
import { prisma } from "@/lib/db";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { readJsonRequest } from "@/lib/request-json";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { hashRequestClientIp } from "@/lib/request-source";
import { enforceAdminMutationRateLimit } from "@/lib/route-rate-limit";
import { requireAdminSession, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

const RestrictionRequestSchema = z.object({
  days: z.number().int().min(1).max(365).nullable().optional(),
  reason: z.string().trim().min(1).max(200),
  status: z.union([z.literal("RESTRICTED"), z.literal("BANNED")])
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
      message: "사용자 제한 요청 형식이 올바르지 않습니다.",
      schema: RestrictionRequestSchema
    });
    if (parsed.kind === "error") {
      return parsed.response;
    }
    const restrictionDays = parsed.data.days ?? null;

    const target = await prisma.user.findUnique({ where: { id: params.id } });
    if (!target) {
      return jsonError(404, "not_found", "사용자를 찾을 수 없습니다.");
    }
    const guard = assertRestrictableUser({ actorId: admin.id, target });
    if (guard.kind === "error") {
      return jsonError(
        403,
        guard.reason,
        guard.reason === "self_restriction" ? "자기 자신은 제한할 수 없습니다." : "관리자 계정은 제한할 수 없습니다."
      );
    }

    let restrictedUntil: Date | null = null;
    if (parsed.data.status === "BANNED" && restrictionDays !== null) {
      return jsonError(400, "bad_request", "영구 차단에는 기간을 설정할 수 없습니다.");
    }
    if (parsed.data.status === "RESTRICTED") {
      if (restrictionDays === null) {
        return jsonError(400, "bad_request", "기간 제한 일수가 필요합니다.");
      }
      restrictedUntil = new Date(Date.now() + restrictionDays * 24 * 60 * 60 * 1000);
    }
    const ipHash = hashRequestClientIp(request);

    const user = await prisma.$transaction(async (transaction) => {
      const updated = await transaction.user.update({
        data: {
          bookingStatus: parsed.data.status,
          restrictedUntil,
          restrictionReason: parsed.data.reason
        },
        where: { id: params.id }
      });
      const action = await transaction.adminAction.create({
        data: {
          action: "USER_RESTRICTION_APPLY",
          actorId: admin.id,
          after: JSON.stringify({
            bookingStatus: updated.bookingStatus,
            restrictedUntil: updated.restrictedUntil,
            restrictionReason: updated.restrictionReason
          }),
          before: JSON.stringify({
            bookingStatus: target.bookingStatus,
            restrictedUntil: target.restrictedUntil,
            restrictionReason: target.restrictionReason
          }),
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
          type: parsed.data.status === "BANNED" ? "ADMIN_BAN" : "ADMIN_RESTRICTION",
          userId: params.id
        }
      });
      await transaction.auditLog.create({
        data: {
          action: "USER_RESTRICTION_APPLY",
          actorId: admin.id,
          detail: JSON.stringify({
            days: restrictionDays,
            reason: parsed.data.reason,
            restrictedUntil,
            status: parsed.data.status
          }),
          userId: params.id
        }
      });
      return updated;
    });

    return NextResponse.json({ user });
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

export async function DELETE(request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<NextResponse> {
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
    const target = await prisma.user.findUnique({ where: { id: params.id } });
    if (!target) {
      return jsonError(404, "not_found", "사용자를 찾을 수 없습니다.");
    }
    const guard = assertRestrictableUser({ actorId: admin.id, target });
    if (guard.kind === "error") {
      return jsonError(
        403,
        guard.reason,
        guard.reason === "self_restriction" ? "자기 자신은 제한할 수 없습니다." : "관리자 계정은 제한할 수 없습니다."
      );
    }
    const ipHash = hashRequestClientIp(request);

    const user = await prisma.$transaction(async (transaction) => {
      const updated = await transaction.user.update({
        data: {
          bookingStatus: "ACTIVE",
          restrictedUntil: null,
          restrictionReason: null
        },
        where: { id: params.id }
      });
      const action = await transaction.adminAction.create({
        data: {
          action: "USER_RESTRICTION_REMOVE",
          actorId: admin.id,
          after: JSON.stringify({
            bookingStatus: updated.bookingStatus,
            restrictedUntil: updated.restrictedUntil,
            restrictionReason: updated.restrictionReason
          }),
          before: JSON.stringify({
            bookingStatus: target.bookingStatus,
            restrictedUntil: target.restrictedUntil,
            restrictionReason: target.restrictionReason
          }),
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
      return updated;
    });
    return NextResponse.json({ user });
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
