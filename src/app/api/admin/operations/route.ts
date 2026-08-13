import { NextResponse } from "next/server";
import { z } from "zod";

import { databaseActorFromSessionUser } from "@/lib/db-context";
import { jsonError } from "@/lib/http";
import { evaluateOperationalJobReadiness, OPERATIONAL_JOB_POLICIES } from "@/lib/operational-jobs";
import { getDiscordOperationsBacklog } from "@/lib/prisma-discord-reservation-message-repository";
import { ForbiddenSessionError, requireAdmin, UnauthorizedSessionError } from "@/lib/session";

const OPERATIONS_ROW_LIMIT = 50;
const JOB_NAMES = [
  "CLOSED_PERIOD_NOTIFICATIONS",
  "DISCORD_INTERACTIONS",
  "DISCORD_RESERVATION_OUTBOX"
] as const;
const RepairActionSchema = z.enum(["verify_remote", "retry", "sync", "remove_controls", "abandon"]);
const HealthSchema = z.object({
  code: z.enum([
    "disabled", "healthy", "last_attempt_failed", "never_run", "never_succeeded",
    "repeated_failures", "running", "running_timeout", "stale"
  ]),
  status: z.enum(["degraded", "ok", "unready"])
}).strict();
const JobSchema = z.object({
  backlogCount: z.number().int().nonnegative(),
  failureCode: z.string().nullable(),
  health: HealthSchema,
  job: z.enum(JOB_NAMES),
  lastAttemptAt: z.string().datetime().nullable(),
  lastSuccessAt: z.string().datetime().nullable(),
  status: z.enum(["FAILED", "RUNNING", "SUCCEEDED"]).nullable()
}).strict();
const CommonItemSchema = z.object({
  createdAt: z.string().datetime(),
  expectedControlEpoch: z.number().int().nonnegative(),
  expectedState: z.string(),
  latestAuditActionId: z.string().nullable(),
  permittedActions: z.array(RepairActionSchema),
  reservationId: z.string(),
  status: z.string(),
  updatedAt: z.string().datetime(),
  userId: z.string()
});
const InteractionItemSchema = CommonItemSchema.extend({
  attempts: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  id: z.string(),
  kind: z.literal("interaction")
}).strict();
const InitialSendItemSchema = CommonItemSchema.extend({
  attempts: z.number().int().nonnegative(),
  id: z.string(),
  kind: z.literal("initial_send"),
  remoteVerificationStatus: z.string().nullable()
}).strict();
const SyncItemSchema = CommonItemSchema.extend({
  id: z.string(),
  kind: z.literal("sync"),
  messageRevision: z.number().int().nonnegative(),
  syncedRevision: z.number().int().nonnegative()
}).strict();
const OperationsResponseSchema = z.object({
  backlogs: z.object({
    initialSends: backlogSchema(InitialSendItemSchema),
    interactions: backlogSchema(InteractionItemSchema),
    syncs: backlogSchema(SyncItemSchema)
  }).strict(),
  control: z.object({
    enabled: z.boolean(),
    epoch: z.number().int().nonnegative(),
    pendingRemoteCleanup: z.boolean()
  }).strict(),
  generatedAt: z.string().datetime(),
  jobs: z.array(JobSchema).length(JOB_NAMES.length)
}).strict();
const EmptyQuerySchema = z.object({}).strict();

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    const query = Object.fromEntries(new URL(request.url).searchParams.entries());
    if (!EmptyQuerySchema.safeParse(query).success) {
      return jsonError(400, "bad_request", "지원하지 않는 운영 조회 조건입니다.");
    }
    const now = new Date();
    const snapshot = await getDiscordOperationsBacklog({
      actor: databaseActorFromSessionUser(admin),
      limit: OPERATIONS_ROW_LIMIT,
      now
    });
    return NextResponse.json(OperationsResponseSchema.parse(buildResponse(snapshot, now)));
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

function buildResponse(
  snapshot: Awaited<ReturnType<typeof getDiscordOperationsBacklog>>,
  now: Date
) {
  return {
    backlogs: {
      initialSends: {
        count: snapshot.initialSends.count,
        items: snapshot.initialSends.rows.map((row) => ({
          attempts: row.initialSendAttempts,
          createdAt: row.createdAt.toISOString(),
          expectedControlEpoch: snapshot.control.epoch,
          expectedState: row.initialSendStatus,
          id: row.reservationId,
          kind: "initial_send",
          latestAuditActionId: row.reservation.adminActions[0]?.id ?? null,
          permittedActions: initialSendActions(row),
          remoteVerificationStatus: row.remoteVerificationStatus,
          reservationId: row.reservationId,
          status: row.initialSendStatus,
          updatedAt: row.updatedAt.toISOString(),
          userId: row.reservation.userId
        })),
        oldestAgeMs: snapshot.initialSends.oldestAgeMs
      },
      interactions: {
        count: snapshot.interactions.count,
        items: snapshot.interactions.rows.map((row) => ({
          attempts: row.attempts,
          createdAt: row.createdAt.toISOString(),
          errorCode: row.errorCode,
          expectedControlEpoch: snapshot.control.epoch,
          expectedState: row.status,
          id: row.interactionId,
          kind: "interaction",
          latestAuditActionId: row.reservation.adminActions[0]?.id ?? null,
          permittedActions: [],
          reservationId: row.reservationId,
          status: row.status,
          updatedAt: row.updatedAt.toISOString(),
          userId: row.reservation.userId
        })),
        oldestAgeMs: snapshot.interactions.oldestAgeMs
      },
      syncs: {
        count: snapshot.syncs.count,
        items: snapshot.syncs.rows.map((row) => ({
          createdAt: row.createdAt.toISOString(),
          expectedControlEpoch: snapshot.control.epoch,
          expectedState: syncState(row),
          id: row.reservationId,
          kind: "sync",
          latestAuditActionId: row.reservation.adminActions[0]?.id ?? null,
          messageRevision: row.messageRevision,
          permittedActions: syncActions(row),
          reservationId: row.reservationId,
          status: row.syncStatus,
          syncedRevision: row.syncedRevision,
          updatedAt: row.updatedAt.toISOString(),
          userId: row.reservation.userId
        })),
        oldestAgeMs: snapshot.syncs.oldestAgeMs
      }
    },
    control: snapshot.control,
    generatedAt: now.toISOString(),
    jobs: JOB_NAMES.map((job) => jobDto(job, snapshot.jobs, now))
  };
}

function backlogSchema<TItem extends z.ZodType>(item: TItem) {
  return z.object({
    count: z.number().int().nonnegative(),
    items: z.array(item).max(OPERATIONS_ROW_LIMIT),
    oldestAgeMs: z.number().int().nonnegative().nullable()
  }).strict();
}

function jobDto(
  job: (typeof JOB_NAMES)[number],
  rows: Awaited<ReturnType<typeof getDiscordOperationsBacklog>>["jobs"],
  now: Date
) {
  const row = rows.find((candidate) => candidate.job === job) ?? null;
  const state = row === null ? null : {
    consecutiveFailures: row.consecutiveFailures,
    finishedAt: row.finishedAt,
    lastAttemptAt: row.lastAttemptAt,
    lastSuccessAt: row.lastSuccessAt,
    startedAt: row.startedAt,
    status: parseJobStatus(row.status)
  };
  return {
    backlogCount: row?.backlogCount ?? 0,
    failureCode: row?.failureCode ?? null,
    health: evaluateOperationalJobReadiness({
      enabled: true,
      now,
      policy: OPERATIONAL_JOB_POLICIES[job],
      state
    }),
    job,
    lastAttemptAt: row?.lastAttemptAt.toISOString() ?? null,
    lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
    status: row === null ? null : parseJobStatus(row.status)
  };
}

function initialSendActions(row: {
  readonly initialSendAttempts: number;
  readonly initialSendOutcome: string | null;
  readonly initialSendStatus: string;
  readonly remoteVerificationStatus: string | null;
}): readonly (z.infer<typeof RepairActionSchema>)[] {
  if (row.initialSendStatus === "PENDING_REVIEW") {
    return row.remoteVerificationStatus === "ERROR"
      || row.remoteVerificationStatus === "MULTIPLE"
      || row.remoteVerificationStatus === "ZERO_COMPLETE"
      ? ["verify_remote", "abandon"]
      : ["verify_remote"];
  }
  return (row.initialSendStatus === "FAILED" || row.initialSendStatus === "RETRY")
    && row.initialSendOutcome === "FAILED"
    && row.initialSendAttempts < 8
    ? ["retry"]
    : [];
}

function syncActions(row: {
  readonly messageId: string | null;
  readonly messageRevision: number;
  readonly reservation: { readonly status: string };
  readonly syncedRevision: number;
}): readonly (z.infer<typeof RepairActionSchema>)[] {
  if (row.messageId === null) return [];
  if (row.reservation.status === "CANCELLED" || row.reservation.status === "NO_SHOW") {
    return ["remove_controls"];
  }
  return row.messageRevision > row.syncedRevision ? ["sync"] : [];
}

function syncState(row: {
  readonly messageRevision: number;
  readonly renderedSourceEpoch: number;
  readonly syncStatus: string;
  readonly syncedRevision: number;
}): string {
  return `${row.syncStatus}:${row.messageRevision}:${row.syncedRevision}:${row.renderedSourceEpoch}`;
}

function parseJobStatus(value: string): "FAILED" | "RUNNING" | "SUCCEEDED" {
  return z.enum(["FAILED", "RUNNING", "SUCCEEDED"]).parse(value);
}
