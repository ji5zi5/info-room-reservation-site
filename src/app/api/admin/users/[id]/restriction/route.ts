import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { requireAdmin, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

const RestrictionRequestSchema = z.object({
  days: z.number().int().min(1).max(365).nullable().optional(),
  reason: z.string().min(1).max(200),
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

    const restrictedUntil =
      parsed.data.status === "RESTRICTED" && parsed.data.days
        ? new Date(Date.now() + parsed.data.days * 24 * 60 * 60 * 1000)
        : null;

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
          detail: JSON.stringify({ reason: parsed.data.reason, status: parsed.data.status }),
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
