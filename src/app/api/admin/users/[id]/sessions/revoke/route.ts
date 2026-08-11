import { NextResponse } from "next/server";
import { z } from "zod";

import { assertRestrictableUser } from "@/lib/admin-users";
import { summarizeUserSessions } from "@/lib/admin-session-control";
import { databaseActorFromSessionUser, withDatabaseContext } from "@/lib/db-context";
import { prisma } from "@/lib/db";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { readJsonRequest } from "@/lib/request-json";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { hashRequestClientIp } from "@/lib/request-source";
import { enforceAdminMutationRateLimit } from "@/lib/route-rate-limit";
import { requireAdminSession, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

const RevokeSessionsRequestSchema = z.object({
  reason: z.string().trim().min(1).max(200).default("관리자 세션 종료")
});

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> }
): Promise<NextResponse> {
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
      message: "세션 종료 요청 형식이 올바르지 않습니다.",
      schema: RevokeSessionsRequestSchema
    });
    if (parsed.kind === "error") {
      return parsed.response;
    }
    const ipHash = hashRequestClientIp(request);

    const result = await withDatabaseContext({
      actor: databaseActorFromSessionUser(admin),
      client: prisma,
      operation: async (transaction) => {
        const target = await transaction.user.findUnique({ where: { id: params.id } });
        if (!target) {
          return { kind: "not_found" } as const;
        }
        const guard = assertRestrictableUser({ actorId: admin.id, target });
        if (guard.kind === "error") {
          return { kind: "forbidden", reason: guard.reason } as const;
        }

        const targetSessions = await transaction.session.findMany({
          select: { expiresAt: true },
          where: { userId: target.id }
        });
        const before = summarizeUserSessions(targetSessions, new Date());
        const deleted = await transaction.session.deleteMany({ where: { userId: target.id } });
        const action = await transaction.adminAction.create({
          data: {
            action: "USER_SESSIONS_REVOKE",
            actorId: admin.id,
            after: JSON.stringify({ revokedSessionCount: deleted.count }),
            before: JSON.stringify(before),
            ipHash,
            reason: parsed.data.reason,
            targetUserId: target.id
          }
        });
        await transaction.auditLog.create({
          data: {
            action: "USER_SESSIONS_REVOKE",
            actorId: admin.id,
            detail: JSON.stringify({ actionId: action.id, reason: parsed.data.reason, revokedSessionCount: deleted.count }),
            userId: target.id
          }
        });
        return { kind: "ok", sessionSummary: before, revokedSessionCount: deleted.count } as const;
      }
    });

    if (result.kind === "not_found") {
      return jsonError(404, "not_found", "사용자를 찾을 수 없습니다.");
    }
    if (result.kind === "forbidden") {
      return jsonError(
        403,
        result.reason,
        result.reason === "self_restriction" ? "자기 자신의 세션은 이 화면에서 종료할 수 없습니다." : "관리자 계정 세션은 종료할 수 없습니다."
      );
    }
    return NextResponse.json({
      revokedSessionCount: result.revokedSessionCount,
      sessionSummary: result.sessionSummary
    });
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
