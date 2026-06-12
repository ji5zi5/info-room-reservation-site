import { NextResponse } from "next/server";
import { z } from "zod";

import { buildClosedListNotificationAdminAction } from "@/lib/admin-operation-audit";
import { createClosedPeriodNotificationService } from "@/lib/closed-period-notification-service";
import { prisma } from "@/lib/db";
import { sendDiscordWebhook } from "@/lib/discord-notifications";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
import { prismaClosedPeriodNotificationRepository } from "@/lib/prisma-notification-repository";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { hashRequestClientIp } from "@/lib/request-source";
import { enforceAdminMutationRateLimit } from "@/lib/route-rate-limit";
import { requireAdminSession, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

const ManualSendSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  force: z.boolean().optional(),
  studyPeriod: z.union([z.literal("EIGHTH"), z.literal("FIRST")])
});

export async function POST(request: Request): Promise<NextResponse> {
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
    const rateLimitResult = await enforceAdminMutationRateLimit(request, session.user.id);
    if (rateLimitResult.kind === "blocked") {
      return jsonRateLimitError(rateLimitResult);
    }
    const parsed = ManualSendSchema.safeParse(await request.json());
    if (!parsed.success) {
      return jsonError(400, "bad_request", "마감 명단 전송 요청 형식이 올바르지 않습니다.");
    }
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
      return jsonError(500, "discord_webhook_missing", "Discord webhook 설정이 필요합니다.");
    }
    const ipHash = hashRequestClientIp(request);

    const now = new Date();
    const service = createClosedPeriodNotificationService({
      now,
      repository: prismaClosedPeriodNotificationRepository,
      sender: (payload) => sendDiscordWebhook({ payload, webhookUrl })
    });
    const result = await service.sendClosedPeriod(
      parsed.data.force === undefined
        ? { date: parsed.data.date, studyPeriod: parsed.data.studyPeriod }
        : { date: parsed.data.date, force: parsed.data.force, studyPeriod: parsed.data.studyPeriod }
    );
    if (result.kind === "skipped") {
      return jsonError(409, result.reason, messageForSkipped(result.reason));
    }
    const action = await prisma.adminAction.create({
      data: buildClosedListNotificationAdminAction({
        actorId: session.user.id,
        date: parsed.data.date,
        force: parsed.data.force === true,
        ipHash,
        result,
        studyPeriod: parsed.data.studyPeriod
      })
    });
    await prisma.auditLog.create({
      data: {
        action: "CLOSED_LIST_NOTIFICATION_SEND",
        actorId: session.user.id,
        detail: JSON.stringify({
          actionId: action.id,
          date: parsed.data.date,
          force: parsed.data.force === true,
          kind: result.kind,
          studyPeriod: parsed.data.studyPeriod
        })
      }
    });
    return NextResponse.json(result);
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

function messageForSkipped(reason: "already_sent" | "not_closed" | "not_found"): string {
  switch (reason) {
    case "already_sent":
      return "이미 전송된 마감 명단입니다.";
    case "not_closed":
      return "아직 마감 시간이 지나지 않았습니다.";
    case "not_found":
      return "시간대 설정을 찾을 수 없습니다.";
  }
}
