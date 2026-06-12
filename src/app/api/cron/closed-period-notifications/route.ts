import { NextResponse } from "next/server";

import { createClosedPeriodNotificationService } from "@/lib/closed-period-notification-service";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { jsonError } from "@/lib/http";
import {
  getDueClosedPeriodNotificationCandidates,
  prismaClosedPeriodNotificationRepository
} from "@/lib/prisma-notification-repository";
import { sendDiscordWebhook } from "@/lib/discord-notifications";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return jsonError(401, "unauthorized", "크론 인증이 필요합니다.");
  }
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    return jsonError(500, "discord_webhook_missing", "Discord webhook 설정이 필요합니다.");
  }

  const now = new Date();
  const candidates = await getDueClosedPeriodNotificationCandidates(now);
  const service = createClosedPeriodNotificationService({
    now,
    repository: prismaClosedPeriodNotificationRepository,
    sender: (payload) => sendDiscordWebhook({ payload, webhookUrl })
  });
  const results = [];
  for (const candidate of candidates) {
    results.push(await service.sendClosedPeriod({ date: candidate.date, studyPeriod: candidate.studyPeriod }));
  }
  return NextResponse.json({ processed: results.length, results });
}
