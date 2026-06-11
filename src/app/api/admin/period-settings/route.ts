import { NextResponse } from "next/server";
import { z } from "zod";

import { toKstDate } from "@/lib/date";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { ensurePeriodSettings, getPeriodSummaries } from "@/lib/period-settings";
import { requireAdmin, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

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
    await ensurePeriodSettings(date);
    return NextResponse.json({ periods: await getPeriodSummaries(date) });
  } catch (error) {
    return adminBoundaryError(error);
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    const parsed = PeriodPatchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return jsonError(400, "bad_request", "시간대 설정 형식이 올바르지 않습니다.");
    }

    await prisma.$transaction(async (transaction) => {
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
      await transaction.auditLog.create({
        data: {
          action: "PERIOD_SETTINGS_PATCH",
          actorId: admin.id,
          detail: JSON.stringify({ date: parsed.data.date, periods: parsed.data.periods.length })
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
