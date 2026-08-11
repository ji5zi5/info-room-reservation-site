import { NextResponse } from "next/server";
import { z } from "zod";

import { buildClosedListNotificationReconciliationAdminAction } from "@/lib/admin-operation-audit";
import { createClosedPeriodNotificationService } from "@/lib/closed-period-notification-service";
import { prisma } from "@/lib/db";
import { databaseActorFromSessionUser, withDatabaseContext } from "@/lib/db-context";
import { sendDiscordWebhook } from "@/lib/discord-notifications";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
import { prismaClosedPeriodNotificationRepository } from "@/lib/prisma-notification-repository";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { readJsonRequest } from "@/lib/request-json";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { hashRequestClientIp } from "@/lib/request-source";
import { enforceAdminMutationRateLimit } from "@/lib/route-rate-limit";
import {
  ForbiddenSessionError,
  requireAdminSession,
  UnauthorizedSessionError
} from "@/lib/session";

const ReconciliationSchema = z
  .object({
    action: z.union([z.literal("abandon"), z.literal("confirm_sent"), z.literal("retry")]),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    studyPeriod: z.union([z.literal("EIGHTH"), z.literal("FIRST")])
  })
  .strict();

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
    const parsed = await readJsonRequest(request, {
      message: "마감 명단 알림 조정 요청 형식이 올바르지 않습니다.",
      schema: ReconciliationSchema
    });
    if (parsed.kind === "error") {
      return parsed.response;
    }

    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (parsed.data.action === "retry" && !webhookUrl) {
      return jsonError(500, "discord_webhook_missing", "Discord webhook 설정이 필요합니다.");
    }

    const service = createClosedPeriodNotificationService({
      now: new Date(),
      repository: prismaClosedPeriodNotificationRepository,
      sender: async (payload) => {
        if (!webhookUrl) {
          throw new Error("Discord webhook is unavailable for retry");
        }
        return sendDiscordWebhook({ payload, webhookUrl });
      }
    });
    const result = await service.reconcileClosedPeriod(parsed.data);
    if (result.kind === "conflict") {
      return jsonError(
        409,
        "notification_state_conflict",
        "알림 상태가 이미 변경되었습니다. 대시보드를 새로고침해 주세요."
      );
    }

    const actionData = buildClosedListNotificationReconciliationAdminAction({
      actorId: session.user.id,
      date: parsed.data.date,
      ipHash: hashRequestClientIp(request),
      operation: parsed.data.action,
      result,
      studyPeriod: parsed.data.studyPeriod
    });
    await withDatabaseContext({
      actor: databaseActorFromSessionUser(session.user),
      client: prisma,
      operation: async (transaction) => {
        const action = await transaction.adminAction.create({ data: actionData });
        await transaction.auditLog.create({
          data: {
            action: "CLOSED_LIST_NOTIFICATION_RECONCILE",
            actorId: session.user.id,
            detail: JSON.stringify({
              actionId: action.id,
              date: parsed.data.date,
              operation: parsed.data.action,
              studyPeriod: parsed.data.studyPeriod
            })
          }
        });
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
