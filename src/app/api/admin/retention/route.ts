import { NextResponse } from "next/server";
import { z } from "zod";

import { databaseActorFromSessionUser } from "@/lib/db-context";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { prismaRetentionStore } from "@/lib/prisma-retention-store";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { readJsonRequest } from "@/lib/request-json";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { hashRequestClientIp } from "@/lib/request-source";
import { enforceAdminMutationRateLimit } from "@/lib/route-rate-limit";
import {
  ForbiddenSessionError,
  requireAdmin,
  requireAdminSession,
  UnauthorizedSessionError,
  type SessionUser
} from "@/lib/session";

const HorizonSchema = z.number().int().min(1).max(3650).nullable();
const PolicyPatchSchema = z.object({
  policy: z.object({
    adminDetailDays: HorizonSchema,
    approvedAt: z.string().datetime().nullable(),
    approvedBy: z.string().trim().min(1).max(100).nullable(),
    auditDetailDays: HorizonSchema,
    departedUserIdentityDays: HorizonSchema,
    policyVersion: z.string().trim().min(1).max(100),
    reservationReasonDays: HorizonSchema,
    sanctionReasonDays: HorizonSchema
  }).strict()
}).strict();
const ApplySchema = z.object({
  checksum: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();

export async function GET(): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    if (isNoDatabaseMockMode()) {
      return jsonError(503, "database_required", "보존 정책은 데이터베이스 연결이 필요합니다.");
    }
    return NextResponse.json(
      await prismaRetentionStore.preview({
        actor: databaseActorFromSessionUser(admin),
        now: new Date()
      })
    );
  } catch (error) {
    if (error instanceof UnauthorizedSessionError || error instanceof ForbiddenSessionError) {
      return adminBoundaryError(error);
    }
    throw error;
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
  const prepared = await prepareMutation(request);
  if (prepared instanceof NextResponse) {
    return prepared;
  }
  const parsed = await readJsonRequest(request, {
    message: "보존 정책 형식이 올바르지 않습니다.",
    schema: PolicyPatchSchema
  });
  if (parsed.kind === "error") {
    return parsed.response;
  }
  const policy = await prismaRetentionStore.save({
    actor: databaseActorFromSessionUser(prepared.admin),
    ipHash: prepared.ipHash,
    policy: {
      ...parsed.data.policy,
      approvedAt: parsed.data.policy.approvedAt
        ? new Date(parsed.data.policy.approvedAt)
        : null
    }
  });
  return NextResponse.json({ policy });
}

export async function POST(request: Request): Promise<NextResponse> {
  const prepared = await prepareMutation(request);
  if (prepared instanceof NextResponse) {
    return prepared;
  }
  const parsed = await readJsonRequest(request, {
    message: "보존 정책 적용 형식이 올바르지 않습니다.",
    schema: ApplySchema
  });
  if (parsed.kind === "error") {
    return parsed.response;
  }
  const result = await prismaRetentionStore.applyApproved({
    actor: databaseActorFromSessionUser(prepared.admin),
    expectedChecksum: parsed.data.checksum,
    ipHash: prepared.ipHash,
    now: new Date()
  });
  switch (result.kind) {
    case "applied":
      return NextResponse.json({ result });
    case "disabled":
      return jsonError(409, "retention_purge_disabled", "배포 환경에서 보존 정리가 비활성화되어 있습니다.");
    case "not_approved":
      return NextResponse.json(
        {
          error: {
            code: "retention_policy_unapproved",
            message: "보존 정책 승인 정보가 완전하지 않습니다.",
            missingFields: result.missingFields
          }
        },
        { status: 409 }
      );
    case "stale":
      return NextResponse.json(
        {
          error: {
            code: "retention_preview_stale",
            message: "보존 대상이 변경되었습니다. 다시 확인하세요."
          },
          preview: result.preview
        },
        { status: 409 }
      );
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const prepared = await prepareMutation(request);
  if (prepared instanceof NextResponse) {
    return prepared;
  }
  const policy = await prismaRetentionStore.disable({
    actor: databaseActorFromSessionUser(prepared.admin),
    ipHash: prepared.ipHash
  });
  return NextResponse.json({ policy });
}

async function prepareMutation(
  request: Request
): Promise<{ readonly admin: SessionUser; readonly ipHash: string } | NextResponse> {
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
    if (isNoDatabaseMockMode()) {
      return jsonError(503, "database_required", "보존 정책은 데이터베이스 연결이 필요합니다.");
    }
    const rateLimit = await enforceAdminMutationRateLimit(request, session.user.id);
    if (rateLimit.kind === "blocked") {
      return jsonRateLimitError(rateLimit);
    }
    return {
      admin: session.user,
      ipHash: hashRequestClientIp(request)
    };
  } catch (error) {
    if (error instanceof UnauthorizedSessionError || error instanceof ForbiddenSessionError) {
      return adminBoundaryError(error);
    }
    throw error;
  }
}

function adminBoundaryError(error: UnauthorizedSessionError | ForbiddenSessionError): NextResponse {
  if (error instanceof UnauthorizedSessionError) {
    return jsonError(401, "unauthorized", error.message);
  }
  return jsonError(403, "forbidden", error.message);
}
