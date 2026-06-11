import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { requireAdmin, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

const NoShowRequestSchema = z.object({
  days: z.number().int().min(1).max(365).default(7),
  reason: z.string().max(200).default("노쇼")
});

export async function POST(request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    const params = await context.params;
    const parsed = NoShowRequestSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return jsonError(400, "bad_request", "노쇼 요청 형식이 올바르지 않습니다.");
    }

    const restrictedUntil = new Date(Date.now() + parsed.data.days * 24 * 60 * 60 * 1000);
    const result = await prisma.$transaction(async (transaction) => {
      const reservation = await transaction.reservation.update({
        data: { status: "NO_SHOW" },
        where: { id: params.id }
      });
      const user = await transaction.user.update({
        data: {
          bookingStatus: "RESTRICTED",
          restrictedUntil,
          restrictionReason: parsed.data.reason
        },
        where: { id: reservation.userId }
      });
      await transaction.auditLog.create({
        data: {
          action: "NO_SHOW_RESTRICTION",
          actorId: admin.id,
          detail: JSON.stringify({ days: parsed.data.days, reason: parsed.data.reason, reservationId: params.id }),
          userId: user.id
        }
      });
      return { reservation, user };
    });

    return NextResponse.json(result);
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
