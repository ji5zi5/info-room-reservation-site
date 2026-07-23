import { NextResponse } from "next/server";

import { orderUserSanctions, summarizeUserSanctions } from "@/lib/admin-action-log";
import { summarizeUserSessions } from "@/lib/admin-session-control";
import { orderAdminUserReservations, summarizeAdminUserReservations } from "@/lib/admin-user-detail";
import { toKstDate } from "@/lib/date";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { getMockAdminUserDetail } from "@/lib/mock-reservation-data";
import { requireAdmin, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

export async function GET(_request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<NextResponse> {
  try {
    await requireAdmin();
    const params = await context.params;
    if (isNoDatabaseMockMode()) {
      const detail = getMockAdminUserDetail(params.id);
      if (!detail) {
        return jsonError(404, "not_found", "사용자를 찾을 수 없습니다.");
      }
      return NextResponse.json(detail);
    }

    const user = await prisma.user.findUnique({
      include: {
        auditLogs: {
          orderBy: { createdAt: "desc" },
          take: 20
        },
        adminActionsTargeted: {
          orderBy: { createdAt: "desc" },
          take: 30
        },
        reservations: {
          orderBy: [{ date: "desc" }, { createdAt: "asc" }],
          take: 100
        },
        sessions: {
          select: {
            expiresAt: true
          }
        },
        sanctions: {
          orderBy: { createdAt: "desc" },
          take: 30
        }
      },
      where: { id: params.id }
    });
    if (!user) {
      return jsonError(404, "not_found", "사용자를 찾을 수 없습니다.");
    }

    const reservationHistory = orderAdminUserReservations(user.reservations);
    const sanctions = orderUserSanctions(user.sanctions);
    const now = new Date();
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
        shadowBanProfile: user.shadowBanProfile,
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
      adminActions: user.adminActionsTargeted.map((action) => ({
        action: action.action,
        actorId: action.actorId,
        after: action.after,
        before: action.before,
        createdAt: action.createdAt,
        id: action.id,
        reason: action.reason,
        reservationId: action.reservationId,
        targetUserId: action.targetUserId
      })),
      currentReservations: reservationHistory.filter(
        (reservation) => reservation.status === "CONFIRMED" && reservation.date >= today
      ),
      reservationHistory,
      sanctions: sanctions.map((sanction) => ({
        actorId: sanction.actorId,
        createdAt: sanction.createdAt,
        endsAt: sanction.endsAt,
        id: sanction.id,
        reason: sanction.reason,
        revokedAt: sanction.revokedAt,
        revokedById: sanction.revokedById,
        revokedReason: sanction.revokedReason,
        sourceActionId: sanction.sourceActionId,
        startsAt: sanction.startsAt,
        status: sanction.status,
        type: sanction.type
      })),
      sanctionSummary: summarizeUserSanctions(sanctions),
      sessionSummary: summarizeUserSessions(user.sessions, now),
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
