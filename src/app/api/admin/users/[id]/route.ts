import { NextResponse } from "next/server";

import { orderAdminUserReservations, summarizeAdminUserReservations } from "@/lib/admin-user-detail";
import { toKstDate } from "@/lib/date";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { requireAdmin, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

export async function GET(_request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<NextResponse> {
  try {
    await requireAdmin();
    const params = await context.params;
    const user = await prisma.user.findUnique({
      include: {
        auditLogs: {
          orderBy: { createdAt: "desc" },
          take: 20
        },
        reservations: {
          orderBy: [{ date: "desc" }, { createdAt: "asc" }],
          take: 100
        }
      },
      where: { id: params.id }
    });
    if (!user) {
      return jsonError(404, "not_found", "사용자를 찾을 수 없습니다.");
    }

    const reservationHistory = orderAdminUserReservations(user.reservations);
    const today = toKstDate(new Date());
    return NextResponse.json({
      user: {
        bookingStatus: user.bookingStatus,
        createdAt: user.createdAt,
        generation: user.generation,
        id: user.id,
        name: user.name,
        restrictedUntil: user.restrictedUntil,
        restrictionReason: user.restrictionReason,
        role: user.role,
        studentNumber: user.studentNumber,
        updatedAt: user.updatedAt
      },
      auditLogs: user.auditLogs.map((log) => ({
        action: log.action,
        actorId: log.actorId,
        createdAt: log.createdAt,
        detail: log.detail,
        id: log.id
      })),
      currentReservations: reservationHistory.filter(
        (reservation) => reservation.status === "CONFIRMED" && reservation.date >= today
      ),
      reservationHistory,
      summary: summarizeAdminUserReservations(user.reservations)
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
