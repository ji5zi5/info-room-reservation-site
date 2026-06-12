import { NextResponse } from "next/server";
import { z } from "zod";

import { assertRestrictableUser } from "@/lib/admin-users";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { requireAdmin, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

const RestrictionRequestSchema = z.object({
  days: z.number().int().min(1).max(365).nullable().optional(),
  reason: z.string().trim().min(1).max(200),
  status: z.union([z.literal("RESTRICTED"), z.literal("BANNED")])
});

export async function POST(request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    const params = await context.params;
    const parsed = RestrictionRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return jsonError(400, "bad_request", "사용자 제한 요청 형식이 올바르지 않습니다.");
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
    if (parsed.data.status === "RESTRICTED") {
      if (restrictionDays === null) {
        return jsonError(400, "bad_request", "기간 제한 일수가 필요합니다.");
      }
      restrictedUntil = new Date(Date.now() + restrictionDays * 24 * 60 * 60 * 1000);
    }

    const user = await prisma.$transaction(async (transaction) => {
      const updated = await transaction.user.update({
        data: {
          bookingStatus: parsed.data.status,
          restrictedUntil,
          restrictionReason: parsed.data.reason
        },
        where: { id: params.id }
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

export async function DELETE(_request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
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

    const user = await prisma.$transaction(async (transaction) => {
      const updated = await transaction.user.update({
        data: {
          bookingStatus: "ACTIVE",
          restrictedUntil: null,
          restrictionReason: null
        },
        where: { id: params.id }
      });
      await transaction.auditLog.create({
        data: {
          action: "USER_RESTRICTION_REMOVE",
          actorId: admin.id,
          detail: "{}",
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
