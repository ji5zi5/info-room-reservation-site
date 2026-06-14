import { NextResponse } from "next/server";
import { z } from "zod";

import { buildAdminStatistics } from "@/lib/admin-statistics";
import { toKstDate } from "@/lib/date";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { getMockAdminStatistics } from "@/lib/mock-admin-data";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { requireAdmin, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

const StatisticsQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional()
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const parsed = StatisticsQuerySchema.safeParse({
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined
    });
    if (!parsed.success) {
      return jsonError(400, "bad_request", "날짜 범위 형식이 올바르지 않습니다.");
    }

    const today = toKstDate(new Date());
    const from = parsed.data.from ?? today;
    const to = parsed.data.to ?? from;
    if (from > to) {
      return jsonError(400, "bad_request", "시작 날짜는 종료 날짜보다 늦을 수 없습니다.");
    }
    if (isNoDatabaseMockMode()) {
      return NextResponse.json({ statistics: getMockAdminStatistics({ from, to }) });
    }

    const [reservations, settings] = await Promise.all([
      prisma.reservation.findMany({
        include: {
          user: {
            select: {
              id: true,
              name: true,
              studentNumber: true
            }
          }
        },
        where: { date: { gte: from, lte: to } }
      }),
      prisma.periodSetting.findMany({
        select: {
          capacity: true,
          date: true,
          studyPeriod: true
        },
        where: { date: { gte: from, lte: to } }
      })
    ]);

    return NextResponse.json({
      statistics: buildAdminStatistics({ from, reservations, settings, to })
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
