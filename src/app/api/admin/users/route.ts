import { NextResponse } from "next/server";

import { filterAdminUsers, parseAdminUserStatusFilter } from "@/lib/admin-users";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { getMockAdminUsers } from "@/lib/mock-reservation-data";
import { requireAdmin, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const bookingStatus = parseAdminUserStatusFilter(url.searchParams.get("bookingStatus"));
    const query = url.searchParams.get("query") ?? "";
    if (isNoDatabaseMockMode()) {
      return NextResponse.json({ users: getMockAdminUsers({ bookingStatus, query }) });
    }
    const users = await prisma.user.findMany({
      orderBy: [{ bookingStatus: "desc" }, { studentNumber: "asc" }],
      take: 300
    });
    return NextResponse.json({
      users: filterAdminUsers(users, { bookingStatus, query }).slice(0, 100)
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
