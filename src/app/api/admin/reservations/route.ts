import { NextResponse } from "next/server";

import {
  filterAdminReservations,
  filterAdminReservationsByQuery,
  orderAdminReservations,
  parseAdminReservationStatus,
  parseAdminReservationStudyPeriod
} from "@/lib/admin-reservations";
import { ADMIN_RESERVATION_LIST_SELECT, toAdminReservationDto } from "@/lib/admin-api-dto";
import { toKstDate } from "@/lib/date";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { getMockAdminReservations } from "@/lib/mock-reservation-data";
import { ForbiddenSessionError, requireAdmin, UnauthorizedSessionError } from "@/lib/session";

export { POST } from "./admin-create-reservation";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const date = url.searchParams.get("date") ?? toKstDate(new Date());
    const query = url.searchParams.get("query") ?? "";
    const status = parseAdminReservationStatus(url.searchParams.get("status"));
    const studyPeriod = parseAdminReservationStudyPeriod(url.searchParams.get("studyPeriod"));
    const userId = url.searchParams.get("userId");
    const reservations = isNoDatabaseMockMode()
      ? getMockAdminReservations({ date, filters: { query, studyPeriod, userId }, status })
      : orderAdminReservations(
          filterAdminReservationsByQuery(
            filterAdminReservations(
              await prisma.reservation.findMany({
                select: ADMIN_RESERVATION_LIST_SELECT,
                where: { date }
              }),
              status
            ),
            { query, studyPeriod, userId }
          )
        );
    const response = NextResponse.json({ reservations: reservations.map(toAdminReservationDto) });
    response.headers.set("Cache-Control", "no-store");
    return response;
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
