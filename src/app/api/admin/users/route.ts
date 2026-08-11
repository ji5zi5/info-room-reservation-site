import { NextResponse } from "next/server";

import type { Prisma } from "@prisma/client";

import { ADMIN_USER_LIST_SELECT, toAdminUserDto } from "@/lib/admin-api-dto";
import { parseAdminUserStatusFilter } from "@/lib/admin-users";
import { prisma } from "@/lib/db";
import { databaseActorFromSessionUser, withDatabaseContext } from "@/lib/db-context";
import { jsonError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { getMockAdminUsers } from "@/lib/mock-reservation-data";
import { requireAdmin, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    const url = new URL(request.url);
    const bookingStatus = parseAdminUserStatusFilter(url.searchParams.get("bookingStatus"));
    const query = url.searchParams.get("query") ?? "";
    const trimmedQuery = query.trim();
    const where = {
      ...(bookingStatus === "ALL" ? {} : { bookingStatus }),
      ...(trimmedQuery
        ? {
            OR: [
              { name: { contains: trimmedQuery, mode: "insensitive" as const } },
              { studentNumber: { contains: trimmedQuery, mode: "insensitive" as const } }
            ]
          }
        : {})
    } satisfies Prisma.UserWhereInput;
    const users = isNoDatabaseMockMode()
      ? getMockAdminUsers({ bookingStatus, query })
      : await withDatabaseContext({
          actor: databaseActorFromSessionUser(admin),
          client: prisma,
          operation: (transaction) =>
            transaction.user.findMany({
              orderBy: [{ bookingStatus: "desc" }, { studentNumber: "asc" }],
              select: ADMIN_USER_LIST_SELECT,
              take: 100,
              where
            })
        });
    const response = NextResponse.json({ users: users.map(toAdminUserDto) });
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
