import { NextResponse } from "next/server";

import { activateApplicationContract } from "@/lib/application-contract-activation";
import { createClosedPeriodNotificationService } from "@/lib/closed-period-notification-service";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { parseDiscordApplicationConfig } from "@/lib/discord-app-config";
import { runDiscordAdminCommandCronWorker } from "@/lib/discord-admin-interaction-completion";
import { sendDiscordWebhook } from "@/lib/discord-notifications";
import {
  runDiscordInteractionCronWorker,
  runDiscordReservationOutbox
} from "@/lib/discord-reservation-outbox";
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

export const dynamic = "force-dynamic";

type CronJobOperationResult = {
  readonly backlogCount: number;
  readonly failureCode?: string;
  readonly kind: "failed" | "succeeded";
  readonly oldestBacklogAt: Date | null;
  readonly result: Readonly<Record<string, unknown>>;
  readonly value: unknown;
};

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CLOSED_PERIOD_CRON_SECRET)) {
    return jsonError(401, "unauthorized", "크론 인증이 필요합니다.");
  }
  const now = new Date();
  const jobNames = [
    "DISCORD_ADMIN_CONSOLE",
    "DISCORD_INTERACTIONS",
    "DISCORD_RESERVATION_OUTBOX",
    "CLOSED_PERIOD_NOTIFICATIONS"
  ] as const;
  const settledRuns = await Promise.allSettled([
    runOperationalJob({
      job: "DISCORD_ADMIN_CONSOLE",
      now,
      operation: () => runDiscordAdminConsole(now),
      store: prismaOperationalJobStore
    }),
    runOperationalJob({
      job: "DISCORD_INTERACTIONS",
      now,
      operation: async () => {
        const result = await runDiscordInteractionCronWorker(now);
        return {
          backlogCount: result.backlog.count,
          kind: "succeeded",
          oldestBacklogAt: result.backlog.oldestAt === null ? null : new Date(result.backlog.oldestAt),
          result,
          value: result
        };
      },
      store: prismaOperationalJobStore
    }),
    runOperationalJob({
      job: "DISCORD_RESERVATION_OUTBOX",
      now,
      operation: async () => {
        const result = await runDiscordReservationOutbox({ now });
        const backlogCount = result.kind === "processed"
          ? result.initial.retried + result.initial.review + result.sync.retried + result.sync.abandoned
          : 0;
        return {
          backlogCount,
          kind: "succeeded",
          oldestBacklogAt: null,
          result,
          value: result
        };
      },
      store: prismaOperationalJobStore
    }),
    runOperationalJob({
      job: "CLOSED_PERIOD_NOTIFICATIONS",
      now,
      operation: () => runClosedPeriodNotifications(now),
      store: prismaOperationalJobStore
    })
  ]);
  const jobs = Object.fromEntries(settledRuns.map((settled, index) => [
    jobNames[index],
    settled.status === "fulfilled"
      ? settled.value
      : { failureCode: "unexpected_error", kind: "failed" }
  ]));
  const siblingsSucceeded = settledRuns.every((settled) =>
    settled.status === "fulfilled" && settled.value.kind !== "failed"
  );
  const activationRun = siblingsSucceeded
    ? (await Promise.allSettled([activateApplicationContract({ source: "FIRST_CRON" })]))[0]
    : null;
  const activation = activationRun === null
    ? { kind: "deferred" as const, reason: "sibling_job_failed" as const }
    : activationRun.status === "fulfilled"
      ? activationRun.value
      : { kind: "failed" as const };
  if (activationRun?.status === "rejected") {
    const reason = activationRun.reason;
    console.error(JSON.stringify({
      databaseCode: typeof reason === "object" && reason !== null && "meta" in reason &&
        typeof reason.meta === "object" && reason.meta !== null && "code" in reason.meta
        ? reason.meta.code
        : "unknown",
      errorCode: typeof reason === "object" && reason !== null && "code" in reason && typeof reason.code === "string"
        ? reason.code
        : "unknown",
      errorType: reason instanceof Error ? reason.name : "UnknownError",
      event: "application_contract_activation_failed",
      source: "FIRST_CRON"
    }));
  }
  const ok = siblingsSucceeded && activationRun?.status === "fulfilled";
  return NextResponse.json({ activation, jobs, ok }, { status: ok ? 200 : 502 });
}

async function runClosedPeriodNotifications(now: Date): Promise<CronJobOperationResult> {
  const notificationSettings = isNoDatabaseMockMode()
    ? getMockNotificationSettings()
    : await getPrismaNotificationSettings();
  if (!notificationSettings.closedPeriodNotificationsEnabled) {
    const disabled = { kind: "disabled" as const, processed: 0 };
    return {
      backlogCount: 0,
      kind: "succeeded" as const,
      oldestBacklogAt: null,
      result: disabled,
      value: disabled
    };
  }
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
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
    : summary.failed > 0 ? "discord_delivery_failed" : null;
  return {
    backlogCount: backlog.count,
    ...(failureCode === null ? {} : { failureCode }),
    kind: failureCode === null ? "succeeded" as const : "failed" as const,
    oldestBacklogAt: backlog.oldestAt,
    result: summary,
    value: summary
  };
}

async function runDiscordAdminConsole(now: Date): Promise<CronJobOperationResult> {
  const config = parseDiscordApplicationConfig(process.env);
  if (config === null) {
    const disabled = { kind: "disabled" as const };
    return { backlogCount: 0, kind: "succeeded", oldestBacklogAt: null, result: disabled, value: disabled };
  }
  const result = await runDiscordAdminCommandCronWorker({ config, now });
  return {
    backlogCount: result.commands.retried + result.commands.abandoned + result.deliveries.failed,
    kind: "succeeded",
    oldestBacklogAt: null,
    result,
    value: result
  };
}
