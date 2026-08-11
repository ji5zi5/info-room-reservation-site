import { NextResponse } from "next/server";

import type { User } from "@prisma/client";

import { assertRestrictableUser } from "@/lib/admin-users";
import { prisma } from "@/lib/db";
import { databaseActorFromSessionUser, withDatabaseContext } from "@/lib/db-context";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { enforceAdminMutationRateLimit } from "@/lib/route-rate-limit";
import { ForbiddenSessionError, UnauthorizedSessionError, requireAdminSession } from "@/lib/session";
import type { SessionUser } from "@/lib/session";

export async function prepareAdminRestrictionMutation(request: Request): Promise<NextResponse | SessionUser> {
  const requestSafetyError = requireMutatingRequestSafety(request);
  if (requestSafetyError) {
    return jsonMutatingRequestSafetyError(requestSafetyError);
  }

  const session = await requireAdminSession();
  const csrfResult = await validateRequestCsrf(request, session.id);
  if (csrfResult.kind === "error") {
    return jsonError(403, csrfResult.reason, messageForCsrfError(csrfResult.reason));
  }

  const rateLimitResult = await enforceAdminMutationRateLimit(request, session.user.id);
  if (rateLimitResult.kind === "blocked") {
    return jsonRateLimitError(rateLimitResult);
  }

  return session.user;
}

export async function findRestrictableTarget(actor: SessionUser, targetUserId: string): Promise<NextResponse | User> {
  const target = await withDatabaseContext({
    actor: databaseActorFromSessionUser(actor),
    client: prisma,
    operation: (transaction) => transaction.user.findUnique({ where: { id: targetUserId } })
  });
  if (!target) {
    return jsonError(404, "not_found", "사용자를 찾을 수 없습니다.");
  }

  const guard = assertRestrictableUser({ actorId: actor.id, target });
  if (guard.kind === "error") {
    return jsonError(
      403,
      guard.reason,
      guard.reason === "self_restriction" ? "자기 자신은 제한할 수 없습니다." : "관리자 계정은 제한할 수 없습니다."
    );
  }

  return target;
}

export function stringifyRestrictionSnapshot(
  user: Pick<User, "bookingStatus" | "restrictedUntil" | "restrictionReason" | "shadowBanProfile">
): string {
  return JSON.stringify({
    bookingStatus: user.bookingStatus,
    restrictedUntil: user.restrictedUntil,
    restrictionReason: user.restrictionReason,
    shadowBanProfile: user.shadowBanProfile
  });
}

export function adminSessionErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof UnauthorizedSessionError) {
    return jsonError(401, "unauthorized", error.message);
  }
  return error instanceof ForbiddenSessionError ? jsonError(403, "forbidden", error.message) : null;
}
