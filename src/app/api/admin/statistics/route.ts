import { NextResponse } from "next/server";
import { z } from "zod";

import { buildAdminStatistics } from "@/lib/admin-statistics";
import { toKstDate } from "@/lib/date";
import { prisma } from "@/lib/db";
import { databaseActorFromSessionUser, withDatabaseContext } from "@/lib/db-context";
import { jsonError } from "@/lib/http";
import { getMockAdminStatistics } from "@/lib/mock-admin-data";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { GLOBAL_PERIOD_SETTINGS_DATE } from "@/lib/period-setting-values";
import { requireAdmin, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

const StatisticsDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((date) => {
    const timestamp = Date.parse(`${date}T00:00:00.000Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().startsWith(date);
  });

const StatisticsQuerySchema = z.object({
  from: StatisticsDateSchema.optional(),
  to: StatisticsDateSchema.optional()
});

const MAX_STATISTICS_RANGE_DAYS = 93;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
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
    const rangeDays =
      Math.floor(
        (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / MILLISECONDS_PER_DAY
      ) + 1;
    if (rangeDays > MAX_STATISTICS_RANGE_DAYS) {
      return jsonError(400, "bad_request", "통계 조회 범위는 최대 93일입니다.");
    }
    if (isNoDatabaseMockMode()) {
      return NextResponse.json({ statistics: getMockAdminStatistics({ from, to }) });
    }

    const [reservations, settings] = await withDatabaseContext({
      actor: databaseActorFromSessionUser(admin),
      client: prisma,
      operation: (transaction) =>
        Promise.all([
          transaction.reservation.findMany({
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
          transaction.periodSetting.findMany({
            select: {
              capacity: true,
              date: true,
              studyPeriod: true
            },
            where: {
              OR: [{ date: GLOBAL_PERIOD_SETTINGS_DATE }, { date: { gte: from, lte: to } }]
            }
          })
        ])
    });

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
