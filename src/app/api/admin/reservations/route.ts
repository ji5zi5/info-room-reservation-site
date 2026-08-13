import { NextResponse } from "next/server";
import { z } from "zod";

import { AdminReservationsPayloadSchema } from "@/app/admin/admin-types";
import {
  buildAdminReservationPageQuery,
  buildAdminReservationWhere,
  paginateAdminReservations,
  parseAdminReservationFilters
} from "@/lib/admin-reservations";
import { ADMIN_RESERVATION_LIST_SELECT, toAdminReservationDto } from "@/lib/admin-api-dto";
import {
  ADMIN_PAGE_SIZE,
  AdminCursorError,
  adminPageTimes,
  issueAdminCursor,
  parseAdminCursor,
  sessionSecretForAdminCursor
} from "@/lib/admin-pagination";
import { toKstDate } from "@/lib/date";
import { prisma } from "@/lib/db";
import { databaseActorFromSessionUser, withDatabaseContext } from "@/lib/db-context";
import { jsonError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { getMockAdminReservations } from "@/lib/mock-reservation-data";
import { mockReservations } from "@/lib/mock-reservation-state";
import { ForbiddenSessionError, requireAdmin, UnauthorizedSessionError } from "@/lib/session";

export { POST } from "./admin-create-reservation";

const ReservationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,191}$/u);

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    const url = new URL(request.url);
    const now = new Date();
    const filters = parseAdminReservationFilters(url.searchParams, toKstDate(now));
    const reservationIdValue = url.searchParams.get("reservationId");
    const reservationId = ReservationIdSchema.safeParse(reservationIdValue);
    if (reservationIdValue !== null && !reservationId.success) {
      return jsonError(400, "bad_request", "예약 ID가 올바르지 않습니다.");
    }
    if (isNoDatabaseMockMode()) {
      if (reservationId.success) {
        const items = mockReservations.filter((reservation) => reservation.id === reservationId.data).slice(0, 1);
        return reservationPageResponse({ cutoff: now, currentTotalCount: items.length, expiresAt: adminPageTimes({ cutoff: now, issuedAt: now }).expiresAt, items, nextCursor: null });
      }
      const cursorValue = url.searchParams.get("cursor");
      const parsedCursor = cursorValue === null
        ? null
        : parseAdminCursor({ cursor: cursorValue, filters, now, resource: "reservations", secret: sessionSecretForAdminCursor() });
      if (parsedCursor !== null && parsedCursor.resource !== "reservations") {
        throw new AdminCursorError("CURSOR_RESOURCE_MISMATCH", "cursor belongs to another resource");
      }
      const cutoff = parsedCursor === null ? now : new Date(parsedCursor.cutoff);
      const page = paginateAdminReservations({
        after: parsedCursor?.last ?? null,
        cutoff,
        rows: getMockAdminReservations({
          date: filters.date,
          filters: { query: filters.query, studyPeriod: filters.studyPeriod, userId: filters.userId },
          status: filters.status
        })
      });
      const nextCursor = page.next === null
        ? null
        : issueAdminCursor({ cutoff, filters, last: page.next, now, resource: "reservations", secret: sessionSecretForAdminCursor() });
      const expiresAt = parsedCursor === null ? adminPageTimes({ cutoff, issuedAt: now }).expiresAt : new Date(parsedCursor.exp).toISOString();
      return reservationPageResponse({ cutoff, currentTotalCount: page.currentTotal, expiresAt, items: page.rows, nextCursor });
    }
    const result = await withDatabaseContext({
      actor: databaseActorFromSessionUser(admin),
      client: prisma,
      operation: async (transaction) => {
        if (reservationId.success) {
          const items = await transaction.reservation.findMany({
            select: ADMIN_RESERVATION_LIST_SELECT,
            take: 1,
            where: { id: reservationId.data }
          });
          return { cutoff: now, currentTotalCount: items.length, expiresAt: adminPageTimes({ cutoff: now, issuedAt: now }).expiresAt, items, nextCursor: null };
        }
        const cursorValue = url.searchParams.get("cursor");
        const parsedCursor = cursorValue === null
          ? null
          : parseAdminCursor({ cursor: cursorValue, filters, now, resource: "reservations", secret: sessionSecretForAdminCursor() });
        if (parsedCursor !== null && parsedCursor.resource !== "reservations") {
          throw new AdminCursorError("CURSOR_RESOURCE_MISMATCH", "cursor belongs to another resource");
        }
        const cutoff = parsedCursor === null ? now : new Date(parsedCursor.cutoff);
        const after = parsedCursor?.last ?? null;
        const [currentTotalCount, rows] = await Promise.all([
          transaction.reservation.count({ where: buildAdminReservationWhere({ after: null, cutoff, filters }) }),
          transaction.reservation.findMany({
            ...buildAdminReservationPageQuery({ after, cutoff, filters }),
            select: ADMIN_RESERVATION_LIST_SELECT
          })
        ]);
        const items = rows.slice(0, ADMIN_PAGE_SIZE);
        const last = items.at(-1);
        const period = last?.studyPeriod;
        const nextCursor = rows.length > ADMIN_PAGE_SIZE && last !== undefined && (period === "EIGHTH" || period === "FIRST")
          ? issueAdminCursor({ cutoff, filters, last: { createdAt: last.createdAt.toISOString(), id: last.id, studyPeriod: period }, now, resource: "reservations", secret: sessionSecretForAdminCursor() })
          : null;
        const expiresAt = parsedCursor === null ? adminPageTimes({ cutoff, issuedAt: now }).expiresAt : new Date(parsedCursor.exp).toISOString();
        return { cutoff, currentTotalCount, expiresAt, items, nextCursor };
      }
    });
    const response = reservationPageResponse(result);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      return jsonError(401, "unauthorized", error.message);
    }
    if (error instanceof ForbiddenSessionError) {
      return jsonError(403, "forbidden", error.message);
    }
    if (error instanceof AdminCursorError) {
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: 400 });
    }
    throw error;
  }
}

function reservationPageResponse(input: {
  readonly cutoff: Date;
  readonly currentTotalCount: number;
  readonly expiresAt: string;
  readonly items: readonly Parameters<typeof toAdminReservationDto>[0][];
  readonly nextCursor: string | null;
}): NextResponse {
  return NextResponse.json(AdminReservationsPayloadSchema.parse({
    cutoff: input.cutoff.toISOString(),
    currentTotalCount: input.currentTotalCount,
    expiresAt: input.expiresAt,
    items: input.items.map(toAdminReservationDto),
    nextCursor: input.nextCursor
  }));
}
