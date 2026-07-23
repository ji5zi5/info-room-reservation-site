import { NextResponse } from "next/server";
import { z } from "zod";

import { buildNotificationSettingsPatchAdminAction } from "@/lib/admin-operation-audit";
import { databaseActorFromSessionUser, withDatabaseContext } from "@/lib/db-context";
import { prisma } from "@/lib/db";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { getMockNotificationSettings, updateMockNotificationSettings } from "@/lib/mock-notification-settings";
import { GLOBAL_NOTIFICATION_SETTINGS_ID, normalizeNotificationSettings } from "@/lib/notification-settings";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { readJsonRequest } from "@/lib/request-json";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { hashRequestClientIp } from "@/lib/request-source";
import { enforceAdminMutationRateLimit } from "@/lib/route-rate-limit";
import { requireAdmin, requireAdminSession, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

const NotificationSettingsSchema = z.object({
  closedPeriodNotificationsEnabled: z.boolean(),
  reservationCreatedNotificationsEnabled: z.boolean()
}).strict();

const NotificationSettingsPatchSchema = z.object({
  notificationSettings: NotificationSettingsSchema
}).strict();

export async function GET(): Promise<NextResponse> {
  try {
    await requireAdmin();
    if (isNoDatabaseMockMode()) {
      return NextResponse.json({ notificationSettings: getMockNotificationSettings() });
    }
    const notificationSettings = await withDatabaseContext({
      actor: { id: null, role: "SYSTEM" },
      client: prisma,
      operation: async (transaction) =>
        normalizeNotificationSettings(
          await transaction.notificationSetting.findUnique({ where: { id: GLOBAL_NOTIFICATION_SETTINGS_ID } })
        )
    });
    return NextResponse.json({ notificationSettings });
  } catch (error) {
    if (error instanceof UnauthorizedSessionError || error instanceof ForbiddenSessionError) {
      return adminBoundaryError(error);
    }
    throw error;
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
      message: "알림 설정 형식이 올바르지 않습니다.",
      schema: NotificationSettingsPatchSchema
    });
    if (parsed.kind === "error") {
      return parsed.response;
    }
    if (isNoDatabaseMockMode()) {
      return NextResponse.json({
        notificationSettings: updateMockNotificationSettings(parsed.data.notificationSettings)
      });
    }

    const admin = session.user;
    const rateLimitResult = await enforceAdminMutationRateLimit(request, admin.id);
    if (rateLimitResult.kind === "blocked") {
      return jsonRateLimitError(rateLimitResult);
    }
    const ipHash = hashRequestClientIp(request);

    const notificationSettings = await withDatabaseContext({
      actor: databaseActorFromSessionUser(admin),
      client: prisma,
      operation: async (transaction) => {
        const before = normalizeNotificationSettings(
          await transaction.notificationSetting.findUnique({ where: { id: GLOBAL_NOTIFICATION_SETTINGS_ID } })
        );
        const after = normalizeNotificationSettings(
          await transaction.notificationSetting.upsert({
            create: {
              ...parsed.data.notificationSettings,
              id: GLOBAL_NOTIFICATION_SETTINGS_ID
            },
            update: parsed.data.notificationSettings,
            where: { id: GLOBAL_NOTIFICATION_SETTINGS_ID }
          })
        );
        const action = await transaction.adminAction.create({
          data: buildNotificationSettingsPatchAdminAction({
            actorId: admin.id,
            after,
            before,
            ipHash
          })
        });
        await transaction.auditLog.create({
          data: {
            action: "NOTIFICATION_SETTINGS_PATCH",
            actorId: admin.id,
            detail: JSON.stringify({ actionId: action.id })
          }
        });
        return after;
      }
    });

    return NextResponse.json({ notificationSettings });
  } catch (error) {
    if (error instanceof UnauthorizedSessionError || error instanceof ForbiddenSessionError) {
      return adminBoundaryError(error);
    }
    throw error;
  }
}

function adminBoundaryError(error: UnauthorizedSessionError | ForbiddenSessionError): NextResponse {
  if (error instanceof UnauthorizedSessionError) {
    return jsonError(401, "unauthorized", error.message);
  }
  return jsonError(403, "forbidden", error.message);
}
