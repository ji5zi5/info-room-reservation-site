import { NextResponse } from "next/server";

import { buildAuditActionsCsv, buildDownloadableAdminCsv } from "@/app/admin/admin-csv";
import { AdminAuditActionSchema } from "@/app/admin/admin-types";
import {
  ADMIN_AUDIT_ACTION_LIST_INCLUDE,
  buildAdminAuditActionExportQuery,
  parseAdminAuditActionFilters,
  toAdminAuditActionDto
} from "@/lib/admin-audit-actions";
import { ADMIN_EXPORT_MAX_ROWS, ADMIN_EXPORT_TOO_LARGE_CODE } from "@/lib/admin-pagination";
import { prisma } from "@/lib/db";
import { databaseActorFromSessionUser, withDatabaseContext } from "@/lib/db-context";
import { jsonError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { ForbiddenSessionError, requireAdmin, UnauthorizedSessionError } from "@/lib/session";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    const now = new Date();
    const filters = parseAdminAuditActionFilters(new URL(request.url).searchParams);
    const rows = isNoDatabaseMockMode()
      ? []
      : await withDatabaseContext({
          actor: databaseActorFromSessionUser(admin),
          client: prisma,
          operation: (transaction) => transaction.adminAction.findMany({
            ...buildAdminAuditActionExportQuery({ cutoff: now, filters }),
            include: ADMIN_AUDIT_ACTION_LIST_INCLUDE
          })
        });
    if (rows.length > ADMIN_EXPORT_MAX_ROWS) {
      return NextResponse.json({
        error: { code: ADMIN_EXPORT_TOO_LARGE_CODE, message: "내보내기는 10,000행까지 가능합니다." }
      }, { status: 422 });
    }
    const actions = rows.map(toAdminAuditActionDto).map((action) => AdminAuditActionSchema.parse(action));
    return csvResponse(buildAuditActionsCsv(actions), "admin-audit-actions.csv");
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) return jsonError(401, "unauthorized", error.message);
    if (error instanceof ForbiddenSessionError) return jsonError(403, "forbidden", error.message);
    throw error;
  }
}

function csvResponse(csv: string, filename: string): NextResponse {
  return new NextResponse(buildDownloadableAdminCsv(csv), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": "text/csv; charset=utf-8"
    }
  });
}
