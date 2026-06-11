import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { requireUser, UnauthorizedSessionError } from "@/lib/session";

export async function DELETE(_request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const params = await context.params;
    const reservation = await prisma.reservation.findUnique({ where: { id: params.id } });
    if (!reservation) {
      return jsonError(404, "not_found", "예약을 찾을 수 없습니다.");
    }
    if (reservation.userId !== user.id && user.role !== "ADMIN") {
      return jsonError(403, "forbidden", "예약을 취소할 권한이 없습니다.");
    }
    const updated = await prisma.reservation.update({
      data: { status: "CANCELLED" },
      where: { id: reservation.id }
    });
    return NextResponse.json({ reservation: updated });
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      return jsonError(401, "unauthorized", error.message);
    }
    throw error;
  }
}
