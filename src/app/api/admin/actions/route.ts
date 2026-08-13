import { NextResponse } from "next/server";
import { z } from "zod";

import { AdminAuditActionsPayloadSchema } from "@/app/admin/admin-types";
import {
  ADMIN_AUDIT_ACTION_LIST_INCLUDE,
  buildAdminAuditActionPageQuery,
  buildAdminAuditActionWhere,
  parseAdminAuditActionFilters,
  toAdminAuditActionDto
} from "@/lib/admin-audit-actions";
import {
  ADMIN_PAGE_SIZE,
  AdminCursorError,
  adminPageTimes,
  issueAdminCursor,
  parseAdminCursor,
  sessionSecretForAdminCursor
} from "@/lib/admin-pagination";
import { prisma } from "@/lib/db";
import { databaseActorFromSessionUser, withDatabaseContext } from "@/lib/db-context";
import { jsonError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { ForbiddenSessionError, requireAdmin, UnauthorizedSessionError } from "@/lib/session";

const ExactActionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,191}$/u);

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    const parameters = new URL(request.url).searchParams;
    const exactIdValue = parameters.get("actionId");
    const exactId = ExactActionIdSchema.safeParse(exactIdValue);
    if (exactIdValue !== null && !exactId.success) {
      return jsonError(400, "bad_request", "감사 로그 ID가 올바르지 않습니다.");
    }

    const now = new Date();
    const pageTimes = adminPageTimes({ cutoff: now, issuedAt: now });
    if (isNoDatabaseMockMode()) {
      return auditPageResponse({ cutoff: now, currentTotalCount: 0, expiresAt: pageTimes.expiresAt, items: [], nextCursor: null });
    }

    const filters = parseAdminAuditActionFilters(parameters);
    const result = await withDatabaseContext({
      actor: databaseActorFromSessionUser(admin),
      client: prisma,
      operation: async (transaction) => {
        if (exactId.success) {
          const items = await transaction.adminAction.findMany({
            include: ADMIN_AUDIT_ACTION_LIST_INCLUDE,
            take: 1,
            where: { id: exactId.data }
          });
          return { cutoff: now, currentTotalCount: items.length, expiresAt: pageTimes.expiresAt, items, nextCursor: null };
        }

        const cursorValue = parameters.get("cursor");
        const parsedCursor = cursorValue === null
          ? null
          : parseAdminCursor({ cursor: cursorValue, filters, now, resource: "audits", secret: sessionSecretForAdminCursor() });
        if (parsedCursor !== null && parsedCursor.resource !== "audits") {
          throw new AdminCursorError("CURSOR_RESOURCE_MISMATCH", "cursor belongs to another resource");
        }
        const cutoff = parsedCursor === null ? now : new Date(parsedCursor.cutoff);
        const after = parsedCursor?.last ?? null;
        const [currentTotalCount, rows] = await Promise.all([
          transaction.adminAction.count({ where: buildAdminAuditActionWhere({ after: null, cutoff, filters }) }),
          transaction.adminAction.findMany({
            ...buildAdminAuditActionPageQuery({ after, cutoff, filters }),
            include: ADMIN_AUDIT_ACTION_LIST_INCLUDE
          })
        ]);
        const items = rows.slice(0, ADMIN_PAGE_SIZE);
        const last = items.at(-1);
        const nextCursor = rows.length > ADMIN_PAGE_SIZE && last !== undefined
          ? issueAdminCursor({ cutoff, filters, last: { createdAt: last.createdAt.toISOString(), id: last.id }, now, resource: "audits", secret: sessionSecretForAdminCursor() })
          : null;
        const expiresAt = parsedCursor === null ? pageTimes.expiresAt : new Date(parsedCursor.exp).toISOString();
        return { cutoff, currentTotalCount, expiresAt, items, nextCursor };
      }
    });
    return auditPageResponse(result);
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) return jsonError(401, "unauthorized", error.message);
    if (error instanceof ForbiddenSessionError) return jsonError(403, "forbidden", error.message);
    if (error instanceof AdminCursorError) {
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: 400 });
    }
    throw error;
  }
}

function auditPageResponse(input: {
  readonly cutoff: Date;
  readonly currentTotalCount: number;
  readonly expiresAt: string;
  readonly items: readonly Parameters<typeof toAdminAuditActionDto>[0][];
  readonly nextCursor: string | null;
}): NextResponse {
  const response = NextResponse.json(AdminAuditActionsPayloadSchema.parse({
    cutoff: input.cutoff.toISOString(),
    currentTotalCount: input.currentTotalCount,
    expiresAt: input.expiresAt,
    items: input.items.map(toAdminAuditActionDto),
    nextCursor: input.nextCursor
  }));
  response.headers.set("Cache-Control", "no-store");
  return response;
}
