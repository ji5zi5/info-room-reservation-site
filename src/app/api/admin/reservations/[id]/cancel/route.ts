import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { requireAdmin, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

export async function POST(_request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    const params = await context.params;
    const result = await prisma.$transaction(async (transaction) => {
      const reservation = await transaction.reservation.findUnique({ where: { id: params.id } });
      if (!reservation) {
        return null;
      }
      const updated = await transaction.reservation.update({
        data: { status: "CANCELLED" },
        where: { id: reservation.id }
      });
      await transaction.auditLog.create({
        data: {
          action: "ADMIN_RESERVATION_CANCEL",
          actorId: admin.id,
          detail: JSON.stringify({ reservationId: reservation.id }),
          userId: reservation.userId
        }
      });
      return updated;
    });
    if (!result) {
      return jsonError(404, "not_found", "예약을 찾을 수 없습니다.");
    }
    return NextResponse.json({ reservation: result });
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
