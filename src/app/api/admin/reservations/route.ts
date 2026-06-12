import { NextResponse } from "next/server";

import { toKstDate } from "@/lib/date";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { requireAdmin, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";
import {
  filterAdminReservations,
  filterAdminReservationsByQuery,
  orderAdminReservations,
  parseAdminReservationStatus,
  parseAdminReservationStudyPeriod
} from "@/lib/admin-reservations";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const date = url.searchParams.get("date") ?? toKstDate(new Date());
    const query = url.searchParams.get("query") ?? "";
    const status = parseAdminReservationStatus(url.searchParams.get("status"));
    const studyPeriod = parseAdminReservationStudyPeriod(url.searchParams.get("studyPeriod"));
    const userId = url.searchParams.get("userId");
    const reservations = await prisma.reservation.findMany({
      include: { user: true },
      where: { date }
    });
    return NextResponse.json({
      reservations: orderAdminReservations(
        filterAdminReservationsByQuery(filterAdminReservations(reservations, status), { query, studyPeriod, userId })
      )
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
