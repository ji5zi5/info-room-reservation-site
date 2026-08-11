import { NextResponse } from "next/server";
import { z } from "zod";

import { toKstDate } from "@/lib/date";
import { databaseActorFromSessionUser } from "@/lib/db-context";
import { getAdminDashboard } from "@/lib/admin-dashboard";
import { jsonError } from "@/lib/http";
import { getMockAdminDashboard } from "@/lib/mock-admin-data";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { requireAdmin, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

const DashboardQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional()
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    const url = new URL(request.url);
    const parsed = DashboardQuerySchema.safeParse({ date: url.searchParams.get("date") ?? undefined });
    if (!parsed.success) {
      return jsonError(400, "bad_request", "날짜 형식이 올바르지 않습니다.");
    }
    const date = parsed.data.date ?? toKstDate(new Date());
    if (isNoDatabaseMockMode()) {
      return NextResponse.json({
        notificationBacklog: [],
        periods: getMockAdminDashboard(date, new Date())
      });
    }
    return NextResponse.json(
      await getAdminDashboard(date, new Date(), databaseActorFromSessionUser(admin))
    );
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
