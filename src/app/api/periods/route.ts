import { createHash } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { addDays, toKstDate } from "@/lib/date";
import { jsonError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { getMockPeriodSummaries } from "@/lib/mock-period-summaries";
import { isAllowedPeriodQueryDate, isAllowedPeriodQueryWeekStart } from "@/lib/period-query-policy";
import { getPeriodSummaries, getPeriodWeekSummaries } from "@/lib/period-settings";
import { requireUser, UnauthorizedSessionError } from "@/lib/session";
import {
  StudentPeriodWeekPayloadSchema,
  toStudentPeriodSummary,
  toStudentPeriodWeekPeriod
} from "@/lib/student-period-summary";

const DateTextSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const PeriodQuerySchema = z
  .object({
    date: DateTextSchema.optional(),
    weekStart: DateTextSchema.optional()
  })
  .refine(({ date, weekStart }) => !(date && weekStart));

const PERIODS_CACHE_CONTROL = "private, max-age=0, must-revalidate";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const url = new URL(request.url);
    const parsed = PeriodQuerySchema.safeParse({
      date: url.searchParams.get("date") ?? undefined,
      weekStart: url.searchParams.get("weekStart") ?? undefined
    });
    if (!parsed.success) {
      return jsonError(400, "bad_request", "날짜 형식이 올바르지 않습니다.");
    }
    const now = new Date();
    const weekStart = parsed.data.weekStart;
    if (weekStart) {
      if (!isAllowedPeriodQueryWeekStart(weekStart, now)) {
        return jsonError(400, "bad_request", "조회할 수 없는 예약 주간입니다.");
      }
      const payload = isNoDatabaseMockMode()
        ? StudentPeriodWeekPayloadSchema.parse({
            dates: Array.from({ length: 5 }, (_, index) => addDays(weekStart, index)).map((date) => ({
                date,
                periods: getMockPeriodSummaries(date, { currentUserId: user.id }).map(
                  toStudentPeriodWeekPeriod
                )
              }))
          })
        : StudentPeriodWeekPayloadSchema.parse(
            await getPeriodWeekSummaries(weekStart, { currentUserId: user.id })
          );
      return revalidatedJsonResponse(request, user.id, payload);
    }

    const date = parsed.data.date ?? toKstDate(now);
    if (!isAllowedPeriodQueryDate(date, now)) {
      return jsonError(400, "bad_request", "조회할 수 없는 예약 날짜입니다.");
    }
    const periods = isNoDatabaseMockMode()
      ? getMockPeriodSummaries(date, { currentUserId: user.id })
      : await getPeriodSummaries(date, { currentUserId: user.id });
    return revalidatedJsonResponse(request, user.id, { periods: periods.map(toStudentPeriodSummary) });
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      return jsonError(401, "unauthorized", error.message);
    }
    throw error;
  }
}

function revalidatedJsonResponse(request: Request, userId: string, payload: object): NextResponse {
  const body = JSON.stringify(payload);
  const digest = createHash("sha256").update(userId).update("\0").update(body).digest("hex");
  const etag = `"${digest}"`;
  const headers = new Headers({
    "Cache-Control": PERIODS_CACHE_CONTROL,
    "Content-Type": "application/json; charset=utf-8",
    ETag: etag
  });
  if (matchesIfNoneMatch(request.headers.get("If-None-Match"), etag)) {
    return new NextResponse(null, { headers, status: 304 });
  }
  return new NextResponse(body, { headers, status: 200 });
}

function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (!header) {
    return false;
  }
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value.replace(/^W\//u, "") === etag;
  });
}
