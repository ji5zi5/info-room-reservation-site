import { NextResponse } from "next/server";
import { z } from "zod";

import { toKstDate } from "@/lib/date";
import { jsonError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { getMockPeriodSummaries } from "@/lib/mock-period-summaries";
import { isAllowedPeriodQueryDate } from "@/lib/period-query-policy";
import { getPeriodSummaries } from "@/lib/period-settings";
import { requireUser, UnauthorizedSessionError } from "@/lib/session";

const PeriodQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional()
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const url = new URL(request.url);
    const parsed = PeriodQuerySchema.safeParse({ date: url.searchParams.get("date") ?? undefined });
    if (!parsed.success) {
      return jsonError(400, "bad_request", "날짜 형식이 올바르지 않습니다.");
    }
    const date = parsed.data.date ?? toKstDate(new Date());
    if (!isAllowedPeriodQueryDate(date, new Date())) {
      return jsonError(400, "bad_request", "조회할 수 없는 예약 날짜입니다.");
    }
    if (isNoDatabaseMockMode()) {
      return NextResponse.json({ periods: getMockPeriodSummaries(date, { currentUserId: user.id }) });
    }
    return NextResponse.json({ periods: await getPeriodSummaries(date, { currentUserId: user.id, includeApplicants: true }) });
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      return jsonError(401, "unauthorized", error.message);
    }
    throw error;
  }
}
