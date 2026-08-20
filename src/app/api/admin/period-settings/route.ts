import { NextResponse } from "next/server";
import { z } from "zod";

import { toKstDate } from "@/lib/date";
import { prisma } from "@/lib/db";
import { scheduleDiscordOperationsBoardSync } from "@/lib/discord-operations-board-after-mutation";
import { databaseActorFromSessionUser, withDatabaseContext } from "@/lib/db-context";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
import { buildPeriodSettingsPatchAdminAction } from "@/lib/admin-operation-audit";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { getMockAdminPeriodSettings, updateMockAdminPeriodSettings } from "@/lib/mock-period-settings";
import { getPeriodSummaries } from "@/lib/period-settings";
import {
  GLOBAL_PERIOD_SETTINGS_DATE,
  periodSettingReadDates,
  resolveEffectivePeriodSetting
} from "@/lib/period-setting-values";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { readJsonRequest } from "@/lib/request-json";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { hashRequestClientIp } from "@/lib/request-source";
import { enforceAdminMutationRateLimit } from "@/lib/route-rate-limit";
import { requireAdmin, requireAdminSession, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";
import { STUDY_PERIODS } from "@/lib/study-periods";

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
    const admin = await requireAdmin();
    const date = new URL(request.url).searchParams.get("date") ?? toKstDate(new Date());
    if (isNoDatabaseMockMode()) {
      return NextResponse.json({ periods: getMockAdminPeriodSettings(date) });
    }
    return NextResponse.json({
      periods: await getPeriodSummaries(date, { actor: databaseActorFromSessionUser(admin) })
    });
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
    const actor = databaseActorFromSessionUser(admin);
    const rateLimitResult = await enforceAdminMutationRateLimit(request, admin.id);
    if (rateLimitResult.kind === "blocked") {
      return jsonRateLimitError(rateLimitResult);
    }
    const ipHash = hashRequestClientIp(request);

    await withDatabaseContext({
      actor,
      client: prisma,
      operation: async (transaction) => {
        const beforeRows = await transaction.periodSetting.findMany({
          select: {
            capacity: true,
            closeTime: true,
            date: true,
            enabled: true,
            openTime: true,
            studyPeriod: true
          },
          where: { date: { in: [...periodSettingReadDates(parsed.data.date)] } }
        });
        const before = STUDY_PERIODS.map((studyPeriod) =>
          resolveEffectivePeriodSetting(parsed.data.date, studyPeriod, beforeRows)
        );
        for (const period of parsed.data.periods) {
          const periodData = {
            capacity: period.capacity,
            closeTime: period.closeTime,
            enabled: period.enabled,
            openTime: period.openTime
          };
          await transaction.periodSetting.updateMany({
            data: periodData,
            where: { studyPeriod: period.studyPeriod }
          });
          await transaction.periodSetting.upsert({
            create: {
              ...periodData,
              date: GLOBAL_PERIOD_SETTINGS_DATE,
              studyPeriod: period.studyPeriod
            },
            update: periodData,
            where: {
              date_studyPeriod: {
                date: GLOBAL_PERIOD_SETTINGS_DATE,
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
            detail: JSON.stringify({
              actionId: action.id,
              date: parsed.data.date,
              periods: parsed.data.periods.length,
              scope: "ALL_DATES"
            })
          }
        });
      }
    });

    scheduleDiscordOperationsBoardSync();
    return NextResponse.json({
      periods: await getPeriodSummaries(parsed.data.date, { actor })
    });
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
