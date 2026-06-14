import { NextResponse } from "next/server";
import { z } from "zod";

import {
  classifyAdminAuditAction,
  filterAdminAuditActions,
  orderAdminAuditActions,
  parseAdminAuditActionFilter
} from "@/lib/admin-audit-actions";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { requireAdmin, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

const AdminActionsQuerySchema = z.object({
  action: z.string().nullable(),
  limit: z.coerce.number().int().min(1).max(200).default(80),
  query: z.string().nullable()
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const parsed = AdminActionsQuerySchema.safeParse({
      action: url.searchParams.get("action"),
      limit: url.searchParams.get("limit") ?? undefined,
      query: url.searchParams.get("query")
    });
    if (!parsed.success) {
      return jsonError(400, "bad_request", "감사 로그 검색 조건이 올바르지 않습니다.");
    }

    const filter = parseAdminAuditActionFilter(parsed.data.action);
    if (isNoDatabaseMockMode()) {
      return NextResponse.json({ actions: [] });
    }
    const rows = await prisma.adminAction.findMany({
      include: {
        actor: { select: { id: true, name: true, studentNumber: true } },
        targetUser: { select: { id: true, name: true, studentNumber: true } }
      },
      orderBy: { createdAt: "desc" },
      take: 200
    });
    const actions = orderAdminAuditActions(
      filterAdminAuditActions(rows, { action: filter, query: parsed.data.query ?? "" })
    ).slice(0, parsed.data.limit);

    return NextResponse.json({
      actions: actions.map((action) => ({
        action: action.action,
        actor: action.actor,
        actorId: action.actorId,
        after: action.after,
        before: action.before,
        category: classifyAdminAuditAction(action.action),
        createdAt: action.createdAt,
        id: action.id,
        reason: action.reason,
        reservationId: action.reservationId,
        targetUser: action.targetUser,
        targetUserId: action.targetUserId
      }))
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
