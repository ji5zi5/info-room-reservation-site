import { NextResponse } from "next/server";
import { z } from "zod";

import { AdminUsersPayloadSchema } from "@/app/admin/admin-types";
import { ADMIN_USER_LIST_SELECT, toAdminUserDto } from "@/lib/admin-api-dto";
import {
  ADMIN_PAGE_SIZE,
  AdminCursorError,
  adminPageTimes,
  issueAdminCursor,
  parseAdminCursor,
  sessionSecretForAdminCursor
} from "@/lib/admin-pagination";
import {
  buildAdminUserPageQuery,
  buildAdminUserWhere,
  filterAdminUsers,
  normalizeAdminUserFilters,
  paginateAdminUsers,
  parseAdminUserStatusFilter
} from "@/lib/admin-users";
import { prisma } from "@/lib/db";
import { databaseActorFromSessionUser, withDatabaseContext } from "@/lib/db-context";
import { jsonError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { mockReservationUsersById } from "@/lib/mock-reservation-state";
import { requireAdmin, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

const ExactIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,191}$/u);

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    const parameters = new URL(request.url).searchParams;
    const exactIdValue = parameters.get("userId");
    const exactId = ExactIdSchema.safeParse(exactIdValue);
    if (exactIdValue !== null && !exactId.success) {
      return jsonError(400, "bad_request", "학생 ID가 올바르지 않습니다.");
    }
    const now = new Date();
    if (isNoDatabaseMockMode()) {
      if (exactId.success) {
        const items = [mockReservationUsersById.get(exactId.data)].filter((user) => user !== undefined);
        return pageResponse({ currentTotalCount: items.length, cutoff: now, expiresAt: adminPageTimes({ cutoff: now, issuedAt: now }).expiresAt, items, nextCursor: null });
      }
      const filters = normalizeAdminUserFilters({
        bookingStatus: parseAdminUserStatusFilter(parameters.get("bookingStatus")),
        query: parameters.get("query") ?? ""
      });
      const cursorValue = parameters.get("cursor");
      const parsedCursor = cursorValue === null
        ? null
        : parseAdminCursor({ cursor: cursorValue, filters, now, resource: "users", secret: sessionSecretForAdminCursor() });
      if (parsedCursor !== null && parsedCursor.resource !== "users") {
        throw new AdminCursorError("CURSOR_RESOURCE_MISMATCH", "cursor belongs to another resource");
      }
      const cutoff = parsedCursor === null ? now : new Date(parsedCursor.cutoff);
      const page = paginateAdminUsers({
        after: parsedCursor?.last ?? null,
        cutoff,
        rows: filterAdminUsers([...mockReservationUsersById.values()], filters).map((user) => ({
          ...user,
          createdAt: new Date(0)
        }))
      });
      const nextCursor = page.next === null
        ? null
        : issueAdminCursor({ cutoff, filters, last: page.next, now, resource: "users", secret: sessionSecretForAdminCursor() });
      const expiresAt = parsedCursor === null
        ? adminPageTimes({ cutoff, issuedAt: now }).expiresAt
        : new Date(parsedCursor.exp).toISOString();
      return pageResponse({
        currentTotalCount: page.currentTotal,
        cutoff,
        expiresAt,
        items: page.rows,
        nextCursor
      });
    }

    const result = await withDatabaseContext({
      actor: databaseActorFromSessionUser(admin),
      client: prisma,
      operation: async (transaction) => {
        if (exactId.success) {
          const items = await transaction.user.findMany({
            select: { ...ADMIN_USER_LIST_SELECT, createdAt: true },
            take: 1,
            where: { id: exactId.data }
          });
          return { cutoff: now, currentTotalCount: items.length, expiresAt: adminPageTimes({ cutoff: now, issuedAt: now }).expiresAt, items, nextCursor: null };
        }
        const filters = normalizeAdminUserFilters({
          bookingStatus: parseAdminUserStatusFilter(parameters.get("bookingStatus")),
          query: parameters.get("query") ?? ""
        });
        const cursorValue = parameters.get("cursor");
        const parsedCursor = cursorValue === null
          ? null
          : parseAdminCursor({ cursor: cursorValue, filters, now, resource: "users", secret: sessionSecretForAdminCursor() });
        if (parsedCursor !== null && parsedCursor.resource !== "users") {
          throw new AdminCursorError("CURSOR_RESOURCE_MISMATCH", "cursor belongs to another resource");
        }
        const cutoff = parsedCursor === null ? now : new Date(parsedCursor.cutoff);
        const after = parsedCursor?.last ?? null;
        const [currentTotalCount, rows] = await Promise.all([
          transaction.user.count({ where: buildAdminUserWhere({ after: null, cutoff, filters }) }),
          transaction.user.findMany({
            ...buildAdminUserPageQuery({ after, cutoff, filters }),
            select: { ...ADMIN_USER_LIST_SELECT, createdAt: true }
          })
        ]);
        const items = rows.slice(0, ADMIN_PAGE_SIZE);
        const last = items.at(-1);
        const nextCursor = rows.length > ADMIN_PAGE_SIZE && last !== undefined
          ? issueAdminCursor({ cutoff, filters, last: { createdAt: last.createdAt.toISOString(), id: last.id }, now, resource: "users", secret: sessionSecretForAdminCursor() })
          : null;
        const expiresAt = parsedCursor === null
          ? adminPageTimes({ cutoff, issuedAt: now }).expiresAt
          : new Date(parsedCursor.exp).toISOString();
        return { cutoff, currentTotalCount, expiresAt, items, nextCursor };
      }
    });
    return pageResponse(result);
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) return jsonError(401, "unauthorized", error.message);
    if (error instanceof ForbiddenSessionError) return jsonError(403, "forbidden", error.message);
    if (error instanceof AdminCursorError) {
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: 400 });
    }
    throw error;
  }
}

function pageResponse(input: {
  readonly currentTotalCount: number;
  readonly cutoff: Date;
  readonly expiresAt: string;
  readonly items: readonly Parameters<typeof toAdminUserDto>[0][];
  readonly nextCursor: string | null;
}): NextResponse {
  const payload = AdminUsersPayloadSchema.parse({
    cutoff: input.cutoff.toISOString(),
    currentTotalCount: input.currentTotalCount,
    expiresAt: input.expiresAt,
    items: input.items.map(toAdminUserDto),
    nextCursor: input.nextCursor
  });
  const response = NextResponse.json(payload);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
