import { NextResponse } from "next/server";

import { createClosedPeriodNotificationService } from "@/lib/closed-period-notification-service";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { runDiscordReservationOutbox, type DiscordReservationOutboxRunResult } from "@/lib/discord-reservation-outbox";
import { jsonError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { getMockNotificationSettings } from "@/lib/mock-notification-settings";
import { getPrismaNotificationSettings } from "@/lib/prisma-notification-settings";
import {
  getClosedPeriodNotificationBacklogSummary,
  getDueClosedPeriodNotificationCandidates,
  prismaClosedPeriodNotificationRepository
} from "@/lib/prisma-notification-repository";
import { runOperationalJob } from "@/lib/operational-job-runner";
import { prismaOperationalJobStore } from "@/lib/prisma-operational-job-store";
import { sendDiscordWebhook } from "@/lib/discord-notifications";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CLOSED_PERIOD_CRON_SECRET)) {
    return jsonError(401, "unauthorized", "크론 인증이 필요합니다.");
  }
  const now = new Date();
  const reservationOutbox = await runReservationOutboxSafely(now);
  const noDatabaseMockMode = isNoDatabaseMockMode();
  const notificationSettings = noDatabaseMockMode
    ? getMockNotificationSettings()
    : await getPrismaNotificationSettings();
  if (!notificationSettings.closedPeriodNotificationsEnabled) {
    return NextResponse.json({
      processed: 0,
      reservationOutbox,
      results: [],
      skipped: "closed_period_notifications_disabled"
    });
  }
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const run = await runOperationalJob({
    job: "CLOSED_PERIOD_NOTIFICATIONS",
    now,
    operation: async () => {
      if (!webhookUrl) {
        return {
          backlogCount: 0,
          failureCode: "discord_webhook_missing",
          kind: "failed" as const,
          oldestBacklogAt: null,
          result: { status: "discord_webhook_missing" },
          value: null
        };
      }
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
      const backlog = await getClosedPeriodNotificationBacklogSummary(now);
      const summary = {
        backlog: { count: backlog.count, oldestAt: backlog.oldestAt?.toISOString() ?? null },
        failed: results.filter((result) => result.kind === "failed").length,
        processed: results.length,
        sent: results.filter((result) => result.kind === "sent").length,
        skipped: results.filter((result) => result.kind === "skipped").length,
        unknown: results.filter((result) => result.kind === "unknown").length
      };
      const failureCode = summary.unknown > 0
        ? "discord_delivery_unknown"
        : summary.failed > 0
          ? "discord_delivery_failed"
          : null;
      return {
        backlogCount: backlog.count,
        ...(failureCode ? { failureCode } : {}),
        kind: failureCode ? "failed" as const : "succeeded" as const,
        oldestBacklogAt: backlog.oldestAt,
        result: summary,
        value: summary
      };
    },
    store: prismaOperationalJobStore
  });
  if (run.kind === "already_running") {
    return NextResponse.json({ reservationOutbox, status: "already_running" }, { status: 202 });
  }
  if (run.kind === "failed") {
    if (run.failureCode === "discord_webhook_missing") {
      return NextResponse.json({
        error: { code: "discord_webhook_missing", message: "Discord webhook 설정이 필요합니다." },
        reservationOutbox
      }, { status: 500 });
    }
    if (!run.value) {
      return NextResponse.json({
        error: { code: "server_error", message: "크론 실행에 실패했습니다." },
        reservationOutbox
      }, { status: 500 });
    }
    return NextResponse.json({ ...run.value, reservationOutbox }, { status: 502 });
  }
  return NextResponse.json({ ...run.value, reservationOutbox });
}

type ReservationOutboxReport = DiscordReservationOutboxRunResult | {
  readonly kind: "failed";
  readonly message: "discord_reservation_outbox_failed";
};

async function runReservationOutboxSafely(now: Date): Promise<ReservationOutboxReport> {
  try {
    return await runDiscordReservationOutbox({ now });
  } catch (error) {
    console.error(JSON.stringify({
      event: "discord_reservation_outbox_cron_failed",
      message: error instanceof Error ? error.name : "UnknownError"
    }));
    return { kind: "failed", message: "discord_reservation_outbox_failed" };
  }
}
