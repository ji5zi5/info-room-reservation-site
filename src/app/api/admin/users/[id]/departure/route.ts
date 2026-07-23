import { NextResponse } from "next/server";
import { z } from "zod";

import { assertRestrictableUser } from "@/lib/admin-users";
import {
  databaseActorFromSessionUser,
  TransactionRetryExhaustedError,
  userMutationLockKey,
  withDatabaseMutation
} from "@/lib/db-context";
import { prisma } from "@/lib/db";
import { jsonError, jsonTransactionRetryExhaustedError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { readJsonRequest } from "@/lib/request-json";
import { hashRequestClientIp } from "@/lib/request-source";

import {
  adminSessionErrorResponse,
  prepareAdminRestrictionMutation
} from "../restriction/restriction-route-support";

const DepartureRequestSchema = z.object({
  reason: z.string().trim().min(1).max(200)
}).strict();

type RouteContext = { readonly params: Promise<{ readonly id: string }> };
type DepartureMutation = "clear" | "mark";

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return mutateDeparture(request, context, "mark");
}

export async function DELETE(request: Request, context: RouteContext): Promise<NextResponse> {
  return mutateDeparture(request, context, "clear");
}

async function mutateDeparture(
  request: Request,
  context: RouteContext,
  mutation: DepartureMutation
): Promise<NextResponse> {
  try {
    const admin = await prepareAdminRestrictionMutation(request);
    if (admin instanceof NextResponse) {
      return admin;
    }
    const parsed = await readJsonRequest(request, {
      message: "학적 이탈 요청 형식이 올바르지 않습니다.",
      schema: DepartureRequestSchema
    });
    if (parsed.kind === "error") {
      return parsed.response;
    }
    if (isNoDatabaseMockMode()) {
      return jsonError(503, "database_required", "데이터베이스 연결이 필요한 기능입니다.");
    }

    const { id: targetUserId } = await context.params;
    const ipHash = hashRequestClientIp(request);
    const result = await withDatabaseMutation({
      actor: databaseActorFromSessionUser(admin),
      client: prisma,
      lockKeys: [userMutationLockKey(targetUserId)],
      operation: async (transaction) => {
        const target = await transaction.user.findUnique({ where: { id: targetUserId } });
        if (!target) {
          return { kind: "not_found" } as const;
        }
        const guard = assertRestrictableUser({ actorId: admin.id, target });
        if (guard.kind === "error") {
          return { kind: "forbidden", reason: guard.reason } as const;
        }
        if (target.anonymizedAt) {
          return { kind: "anonymized" } as const;
        }

        const shouldMark = mutation === "mark";
        if ((shouldMark && target.departedAt) || (!shouldMark && !target.departedAt)) {
          return { kind: "ok", user: target } as const;
        }

        const updated = await transaction.user.update({
          data: { departedAt: shouldMark ? new Date() : null },
          where: { id: targetUserId }
        });
        const revokedSessionCount = shouldMark
          ? (await transaction.session.deleteMany({ where: { userId: targetUserId } })).count
          : 0;
        const actionName = shouldMark ? "USER_DEPARTURE_MARK" : "USER_DEPARTURE_CLEAR";
        const action = await transaction.adminAction.create({
          data: {
            action: actionName,
            actorId: admin.id,
            after: departureSnapshot(updated),
            before: departureSnapshot(target),
            ipHash,
            reason: parsed.data.reason,
            targetUserId
          }
        });
        await transaction.auditLog.create({
          data: {
            action: actionName,
            actorId: admin.id,
            detail: JSON.stringify({ actionId: action.id, revokedSessionCount }),
            userId: targetUserId
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
        result.reason === "self_restriction"
          ? "자기 자신은 처리할 수 없습니다."
          : "관리자 계정은 처리할 수 없습니다."
      );
    }
    if (result.kind === "anonymized") {
      return jsonError(409, "bad_request", "이미 익명화된 계정은 되돌릴 수 없습니다.");
    }
    return NextResponse.json({
      user: { departedAt: result.user.departedAt, id: result.user.id }
    });
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

function departureSnapshot(user: { readonly departedAt: Date | null }): string {
  return JSON.stringify({ departedAt: user.departedAt });
}
