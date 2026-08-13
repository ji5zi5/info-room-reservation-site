import { NextResponse } from "next/server";

import { buildDownloadableAdminCsv, buildReservationCsv } from "@/app/admin/admin-csv";
import { ADMIN_RESERVATION_LIST_SELECT, toAdminReservationDto } from "@/lib/admin-api-dto";
import { ADMIN_EXPORT_MAX_ROWS, ADMIN_EXPORT_TOO_LARGE_CODE } from "@/lib/admin-pagination";
import { buildAdminReservationExportQuery, parseAdminReservationFilters } from "@/lib/admin-reservations";
import { toKstDate } from "@/lib/date";
import { prisma } from "@/lib/db";
import { databaseActorFromSessionUser, withDatabaseContext } from "@/lib/db-context";
import { jsonError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { getMockAdminReservations } from "@/lib/mock-reservation-data";
import { ForbiddenSessionError, requireAdmin, UnauthorizedSessionError } from "@/lib/session";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    const now = new Date();
    const filters = parseAdminReservationFilters(new URL(request.url).searchParams, toKstDate(now));
    const rows = isNoDatabaseMockMode()
      ? getMockAdminReservations({
          date: filters.date,
          filters: { query: filters.query, studyPeriod: filters.studyPeriod, userId: filters.userId },
          status: filters.status
        }).slice(0, ADMIN_EXPORT_MAX_ROWS + 1)
      : await withDatabaseContext({
          actor: databaseActorFromSessionUser(admin),
          client: prisma,
          operation: (transaction) => transaction.reservation.findMany({
            ...buildAdminReservationExportQuery({ cutoff: now, filters }),
            select: ADMIN_RESERVATION_LIST_SELECT
          })
        });
    if (rows.length > ADMIN_EXPORT_MAX_ROWS) {
      return NextResponse.json({
        error: { code: ADMIN_EXPORT_TOO_LARGE_CODE, message: "내보내기는 10,000행까지 가능합니다." }
      }, { status: 422 });
    }
    return csvResponse(buildReservationCsv(rows.map(toAdminReservationDto)), "admin-reservations.csv");
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
