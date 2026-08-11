import { NextResponse } from "next/server";
import { z } from "zod";

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
import { databaseActorFromSessionUser, withDatabaseContext } from "@/lib/db-context";
import { jsonError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { getMockAdminReservations } from "@/lib/mock-reservation-data";
import { ForbiddenSessionError, requireAdmin, UnauthorizedSessionError } from "@/lib/session";

export { POST } from "./admin-create-reservation";

const ReservationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,191}$/);

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    const url = new URL(request.url);
    const date = url.searchParams.get("date") ?? toKstDate(new Date());
    const query = url.searchParams.get("query") ?? "";
    const status = parseAdminReservationStatus(url.searchParams.get("status"));
    const studyPeriod = parseAdminReservationStudyPeriod(url.searchParams.get("studyPeriod"));
    const userId = url.searchParams.get("userId");
    const reservationIdValue = url.searchParams.get("reservationId");
    const reservationId = ReservationIdSchema.safeParse(reservationIdValue);
    const mockMode = isNoDatabaseMockMode();
    const reservations =
      reservationIdValue !== null && !reservationId.success
        ? []
        : mockMode
          ? reservationId.success
            ? getMockAdminReservations({ date, reservationId: reservationId.data })
            : getMockAdminReservations({ date, filters: { query, studyPeriod, userId }, status })
          : await withDatabaseContext({
              actor: databaseActorFromSessionUser(admin),
              client: prisma,
              operation: async (transaction) =>
                reservationId.success
                  ? transaction.reservation.findMany({
                      select: ADMIN_RESERVATION_LIST_SELECT,
                      take: 1,
                      where: { date, id: reservationId.data, status: "CONFIRMED" }
                    })
                  : orderAdminReservations(
                      filterAdminReservationsByQuery(
                        filterAdminReservations(
                          await transaction.reservation.findMany({
                            select: ADMIN_RESERVATION_LIST_SELECT,
                            where: { date }
                          }),
                          status
                        ),
                        { query, studyPeriod, userId }
                      )
                    )
            });
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
