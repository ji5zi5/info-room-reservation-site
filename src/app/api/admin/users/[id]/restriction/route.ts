import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { applyMockUserRestriction, removeMockUserRestriction, type MockUserRestrictionResult } from "@/lib/mock-user-restrictions";
import { readJsonRequest } from "@/lib/request-json";
import { hashRequestClientIp } from "@/lib/request-source";

import {
  adminSessionErrorResponse,
  findRestrictableTarget,
  prepareAdminRestrictionMutation,
  stringifyRestrictionSnapshot
} from "./restriction-route-support";

const RestrictionRequestSchema = z.object({
  days: z.number().int().min(1).max(365).nullable().optional(),
  reason: z.string().trim().min(1).max(200),
  status: z.union([z.literal("RESTRICTED"), z.literal("BANNED"), z.literal("SHADOW_BANNED")])
});

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

    let restrictedUntil: Date | null = null;
    if ((parsed.data.status === "BANNED" || parsed.data.status === "SHADOW_BANNED") && restrictionDays !== null) {
      return jsonError(400, "bad_request", "영구 차단에는 기간을 설정할 수 없습니다.");
    }
    if (parsed.data.status === "RESTRICTED") {
      if (restrictionDays === null) {
        return jsonError(400, "bad_request", "기간 제한 일수가 필요합니다.");
      }
      restrictedUntil = new Date(Date.now() + restrictionDays * 24 * 60 * 60 * 1000);
    }
    if (isNoDatabaseMockMode()) {
      return mockRestrictionResultResponse(
        applyMockUserRestriction({
          actorId: admin.id,
          bookingStatus: parsed.data.status,
          restrictedUntil,
          restrictionReason: parsed.data.reason,
          targetUserId: params.id
        })
      );
    }
    const target = await findRestrictableTarget(admin.id, params.id);
    if (target instanceof NextResponse) {
      return target;
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
          after: stringifyRestrictionSnapshot(updated),
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
    const response = adminSessionErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
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
    const target = await findRestrictableTarget(admin.id, params.id);
    if (target instanceof NextResponse) {
      return target;
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
      return updated;
    });
    return NextResponse.json({ user });
  } catch (error) {
    const response = adminSessionErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
}

function mockRestrictionResultResponse(result: MockUserRestrictionResult): NextResponse {
  switch (result.kind) {
    case "ok":
      return NextResponse.json({ user: result.user });
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
