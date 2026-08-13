import { NextResponse } from "next/server";
import { z } from "zod";

import { createDiscordBotClient } from "@/lib/discord-bot";
import { verifyRemoteDiscordReservationMessage } from "@/lib/discord-reservation-reconciliation";
import { databaseActorFromSessionUser } from "@/lib/db-context";
import { parseServerEnv } from "@/lib/env";
import { jsonError, jsonMutatingRequestSafetyError, jsonRateLimitError } from "@/lib/http";
import {
  createPrismaDiscordRemoteVerificationRepository,
  repairDiscordReservationMessageWithPrisma
} from "@/lib/prisma-discord-reservation-message-repository";
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

const RepairRequestSchema = z.object({
  action: z.enum(["verify_remote", "retry", "sync", "remove_controls", "abandon"]),
  confirmation: z.string().min(1).max(128).optional(),
  expectedControlEpoch: z.number().int().nonnegative(),
  expectedState: z.string().min(1).max(128),
  reservationId: z.string().min(1).max(128)
}).strict().superRefine((value, context) => {
  if (
    (value.action === "remove_controls" || value.action === "abandon")
    && value.confirmation === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "destructive confirmation is required",
      path: ["confirmation"]
    });
  }
});

export async function POST(request: Request): Promise<NextResponse> {
  const safetyError = requireMutatingRequestSafety(request);
  if (safetyError) return jsonMutatingRequestSafetyError(safetyError);

  try {
    const session = await requireAdminSession();
    const csrf = await validateRequestCsrf(request, session.id);
    if (csrf.kind === "error") {
      return jsonError(403, csrf.reason, messageForCsrfError(csrf.reason));
    }
    const parsed = await readJsonRequest(request, {
      message: "Discord 복구 요청 형식이 올바르지 않습니다.",
      schema: RepairRequestSchema
    });
    if (parsed.kind === "error") return parsed.response;
    const rateLimit = await enforceAdminMutationRateLimit(request, session.user.id);
    if (rateLimit.kind === "blocked") return jsonRateLimitError(rateLimit);

    const common = {
      actor: databaseActorFromSessionUser(session.user),
      adminId: session.user.id,
      expectedControlEpoch: parsed.data.expectedControlEpoch,
      expectedState: parsed.data.expectedState,
      ipHash: hashRequestClientIp(request),
      now: new Date(),
      reservationId: parsed.data.reservationId
    } as const;
    if (parsed.data.action === "verify_remote") {
      const config = parseServerEnv().discordApplication;
      if (config === null) {
        return jsonError(503, "server_error", "Discord 애플리케이션 설정이 없습니다.");
      }
      const result = await verifyRemoteDiscordReservationMessage({
        expectedControlEpoch: common.expectedControlEpoch,
        expectedState: common.expectedState,
        repository: createPrismaDiscordRemoteVerificationRepository(common),
        reservationId: common.reservationId,
        transport: createDiscordBotClient({
          applicationId: config.applicationId,
          botToken: config.botToken
        })
      });
      return verificationResponse(result);
    }

    const result = await repairDiscordReservationMessageWithPrisma({
      ...common,
      action: parsed.data.action,
      ...(parsed.data.confirmation === undefined ? {} : { confirmation: parsed.data.confirmation })
    });
    if (result.kind === "not_found") {
      return jsonError(404, "not_found", "Discord 예약 메시지를 찾을 수 없습니다.");
    }
    if (result.kind === "conflict") {
      return jsonError(409, "notification_state_conflict", `Discord 복구 충돌: ${result.code}`);
    }
    return NextResponse.json({ result });
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

function verificationResponse(
  result: Awaited<ReturnType<typeof verifyRemoteDiscordReservationMessage>>
): NextResponse {
  switch (result.kind) {
    case "bound":
    case "unresolved":
      return NextResponse.json({ result });
    case "not_found":
      return jsonError(404, "not_found", "Discord 예약 메시지를 찾을 수 없습니다.");
    case "conflict":
      return jsonError(409, "notification_state_conflict", "Discord 예약 메시지 상태가 변경되었습니다.");
    default:
      return assertNeverVerification(result);
  }
}

function assertNeverVerification(value: never): never {
  throw new DiscordVerificationResponseVariantError(String(value));
}

class DiscordVerificationResponseVariantError extends Error {
  public constructor(value: string) {
    super(`Unhandled Discord verification response: ${value}`);
    this.name = "DiscordVerificationResponseVariantError";
  }
}
