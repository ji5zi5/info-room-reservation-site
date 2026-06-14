import { NextResponse } from "next/server";
import { z } from "zod";

import { toKstDate } from "@/lib/date";
import { prisma } from "@/lib/db";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
import { buildPeriodSettingsPatchAdminAction } from "@/lib/admin-operation-audit";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { getMockAdminPeriodSettings, updateMockAdminPeriodSettings } from "@/lib/mock-period-settings";
import { ensurePeriodSettings, getPeriodSummaries } from "@/lib/period-settings";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { readJsonRequest } from "@/lib/request-json";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { hashRequestClientIp } from "@/lib/request-source";
import { enforceAdminMutationRateLimit } from "@/lib/route-rate-limit";
import { requireAdmin, requireAdminSession, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

const PeriodPatchSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  periods: z.array(
    z.object({
      capacity: z.number().int().min(1).max(200),
      closeTime: z.string().regex(/^\d{2}:\d{2}$/u),
      enabled: z.boolean(),
      openTime: z.string().regex(/^\d{2}:\d{2}$/u),
      studyPeriod: z.union([z.literal("EIGHTH"), z.literal("FIRST")])
    })
  )
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await requireAdmin();
    const date = new URL(request.url).searchParams.get("date") ?? toKstDate(new Date());
    if (isNoDatabaseMockMode()) {
      return NextResponse.json({ periods: getMockAdminPeriodSettings(date) });
    }
    await ensurePeriodSettings(date);
    return NextResponse.json({ periods: await getPeriodSummaries(date) });
  } catch (error) {
    return adminBoundaryError(error);
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
  const requestSafetyError = requireMutatingRequestSafety(request);
  if (requestSafetyError) {
    return jsonMutatingRequestSafetyError(requestSafetyError);
  }

  try {
    const session = await requireAdminSession();
    const csrfResult = await validateRequestCsrf(request, session.id);
    if (csrfResult.kind === "error") {
      return jsonError(403, csrfResult.reason, messageForCsrfError(csrfResult.reason));
    }
    const parsed = await readJsonRequest(request, {
      message: "시간대 설정 형식이 올바르지 않습니다.",
      schema: PeriodPatchSchema
    });
    if (parsed.kind === "error") {
      return parsed.response;
    }
    if (isNoDatabaseMockMode()) {
      return NextResponse.json({ periods: updateMockAdminPeriodSettings(parsed.data.date, parsed.data.periods) });
    }
    const admin = session.user;
    const rateLimitResult = await enforceAdminMutationRateLimit(request, admin.id);
    if (rateLimitResult.kind === "blocked") {
      return jsonRateLimitError(rateLimitResult);
    }
    const ipHash = hashRequestClientIp(request);

    await prisma.$transaction(async (transaction) => {
      const before = await transaction.periodSetting.findMany({
        select: {
          capacity: true,
          closeTime: true,
          enabled: true,
          openTime: true,
          studyPeriod: true
        },
        where: { date: parsed.data.date }
      });
      for (const period of parsed.data.periods) {
        await transaction.periodSetting.upsert({
          create: {
            capacity: period.capacity,
            closeTime: period.closeTime,
            date: parsed.data.date,
            enabled: period.enabled,
            openTime: period.openTime,
            studyPeriod: period.studyPeriod
          },
          update: {
            capacity: period.capacity,
            closeTime: period.closeTime,
            enabled: period.enabled,
            openTime: period.openTime
          },
          where: {
            date_studyPeriod: {
              date: parsed.data.date,
              studyPeriod: period.studyPeriod
            }
          }
        });
      }
      const action = await transaction.adminAction.create({
        data: buildPeriodSettingsPatchAdminAction({
          actorId: admin.id,
          after: parsed.data.periods,
          before,
          date: parsed.data.date,
          ipHash
        })
      });
      await transaction.auditLog.create({
        data: {
          action: "PERIOD_SETTINGS_PATCH",
          actorId: admin.id,
          detail: JSON.stringify({ actionId: action.id, date: parsed.data.date, periods: parsed.data.periods.length })
        }
      });
    });

    return NextResponse.json({ periods: await getPeriodSummaries(parsed.data.date) });
  } catch (error) {
    return adminBoundaryError(error);
  }
}

function adminBoundaryError(error: unknown): NextResponse {
  if (error instanceof UnauthorizedSessionError) {
    return jsonError(401, "unauthorized", error.message);
  }
  if (error instanceof ForbiddenSessionError) {
    return jsonError(403, "forbidden", error.message);
  }
  throw error;
}
