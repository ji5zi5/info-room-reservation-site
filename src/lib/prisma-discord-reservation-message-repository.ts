import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "./db";
import { withDatabaseContext, type DatabaseActor } from "./db-context";
import type {
  DiscordRemoteVerificationContinuation,
  DiscordRemoteVerificationRepository
} from "./discord-reservation-reconciliation";
import {
  beginInitialSendTerminalDelivery,
  beginInitialSendPost,
  createDiscordReservationMessage,
  createDiscordReservationMessageInSystemContext,
  markInitialSendPendingReview,
  readOperationsControl,
  reconcileExpiredInitialPosts,
  saveInitialSendFailure,
  saveInitialSendSuccess
} from "./prisma-discord-reservation-message-initial-send";
import {
  claimInitialSend,
  claimInitialSends,
  claimMessageSync,
  claimMessageSyncs,
  reconcileLegacyDiscordTransportClaims
} from "./prisma-discord-reservation-message-claims";
import {
  deleteExpiredInteractionReceipts,
  deleteExpiredMessages
} from "./prisma-discord-reservation-message-cleanup";
import {
  bumpMessageRevision,
  beginSyncPatch,
  markSyncPendingReview,
  readMessageSyncState,
  reconcileExpiredSyncPatches,
  saveLeasedSyncSuccess,
  saveSyncFailure,
  saveSyncSuccess
} from "./prisma-discord-reservation-message-sync";

export {
  DISCORD_CLAIM_BATCH_SIZE,
  DISCORD_CLAIM_LEASE_MS,
  type DiscordInitialSendClaim,
  type DiscordMessageSyncClaim
} from "./prisma-discord-reservation-message-claims";
export { DISCORD_CLEANUP_BATCH_SIZE } from "./prisma-discord-reservation-message-cleanup";
export {
  findDiscordInteractionTerminalResult,
  recordDiscordInteractionReceipt,
  recordDiscordReservationDecision
} from "./prisma-discord-reservation-message-interactions";
export {
  cappedDiscordRetryAt,
  createDiscordReservationMessage
} from "./prisma-discord-reservation-message-initial-send";
export type { DiscordMessageSyncState } from "./prisma-discord-reservation-message-sync";
export const prismaDiscordReservationMessageRepository = {
  beginInitialSendPost,
  beginInitialSendTerminalDelivery,
  beginSyncPatch,
  bumpMessageRevision,
  claimInitialSend,
  claimInitialSends,
  claimMessageSync,
  claimMessageSyncs,
  reconcileLegacyDiscordTransportClaims,
  create: createDiscordReservationMessageInSystemContext,
  deleteExpiredInteractionReceipts,
  deleteExpiredMessages,
  readMessageSyncState,
  readOperationsControl,
  reconcileExpiredInitialPosts,
  reconcileExpiredSyncPatches,
  markInitialSendPendingReview,
  markSyncPendingReview,
  saveInitialSendFailure,
  saveInitialSendSuccess,
  saveLeasedSyncSuccess,
  saveSyncFailure,
  saveSyncSuccess
} as const;

const INTERACTION_BACKLOG_STATUSES = ["PENDING", "PROCESSING", "RETRY"] as const;
const INITIAL_SEND_BACKLOG_STATUSES = ["ABANDONED", "FAILED", "PENDING_REVIEW", "RETRY"] as const;
const SYNC_BACKLOG_STATUSES = ["ABANDONED", "PENDING", "PENDING_REVIEW", "RETRY"] as const;

export function isDiscordSyncBacklog(input: {
  readonly messageId: string | null;
  readonly syncStatus: string;
}): boolean {
  return input.messageId !== null && SYNC_BACKLOG_STATUSES.some((status) => status === input.syncStatus);
}

export async function getDiscordOperationsBacklog(input: {
  readonly actor: DatabaseActor;
  readonly limit: number;
  readonly now: Date;
}) {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
  return withDatabaseContext({
    actor: input.actor,
    client: prisma,
    operation: async (transaction) => {
      const interactionWhere = {
        handshakeStatus: "ACKNOWLEDGED",
        status: { in: [...INTERACTION_BACKLOG_STATUSES] }
      } satisfies Prisma.DiscordInteractionJobWhereInput;
      const initialSendWhere = {
        initialSendStatus: { in: [...INITIAL_SEND_BACKLOG_STATUSES] }
      } satisfies Prisma.DiscordReservationMessageWhereInput;
      const syncWhere = {
        messageId: { not: null },
        syncStatus: { in: [...SYNC_BACKLOG_STATUSES] }
      } satisfies Prisma.DiscordReservationMessageWhereInput;
      const [control, jobs, interactionRows, interactionSummary, initialRows, initialSummary, syncRows, syncSummary] =
        await Promise.all([
          transaction.discordOperationsControl.findUnique({
            select: { enabled: true, epoch: true, pendingRemoteCleanup: true },
            where: { id: "discord-operations" }
          }),
          transaction.operationalJob.findMany({
            orderBy: { job: "asc" },
            where: { job: { in: ["CLOSED_PERIOD_NOTIFICATIONS", "DISCORD_INTERACTIONS", "DISCORD_RESERVATION_OUTBOX"] } }
          }),
          transaction.discordInteractionJob.findMany({
            include: { reservation: { select: {
              adminActions: { orderBy: { createdAt: "desc" }, select: { id: true }, take: 1 },
              userId: true
            } } },
            orderBy: [{ createdAt: "asc" }, { interactionId: "asc" }],
            take: limit,
            where: interactionWhere
          }),
          transaction.discordInteractionJob.aggregate({
            _count: true,
            _min: { createdAt: true },
            where: interactionWhere
          }),
          transaction.discordReservationMessage.findMany({
            include: { reservation: { select: {
              adminActions: { orderBy: { createdAt: "desc" }, select: { id: true }, take: 1 },
              status: true,
              userId: true
            } } },
            orderBy: [{ createdAt: "asc" }, { reservationId: "asc" }],
            take: limit,
            where: initialSendWhere
          }),
          transaction.discordReservationMessage.aggregate({
            _count: true,
            _min: { createdAt: true },
            where: initialSendWhere
          }),
          transaction.discordReservationMessage.findMany({
            include: { reservation: { select: {
              adminActions: { orderBy: { createdAt: "desc" }, select: { id: true }, take: 1 },
              status: true,
              userId: true
            } } },
            orderBy: [{ createdAt: "asc" }, { reservationId: "asc" }],
            take: limit,
            where: syncWhere
          }),
          transaction.discordReservationMessage.aggregate({
            _count: true,
            _min: { createdAt: true },
            where: syncWhere
          })
        ]);
      return {
        control: control ?? { enabled: false, epoch: 0, pendingRemoteCleanup: false },
        initialSends: backlogClass(initialRows, initialSummary, input.now),
        interactions: backlogClass(interactionRows, interactionSummary, input.now),
        jobs,
        syncs: backlogClass(syncRows.filter(isDiscordSyncBacklog), syncSummary, input.now)
      };
    }
  });
}

function backlogClass<TRow>(
  rows: readonly TRow[],
  summary: { readonly _count: number; readonly _min: { readonly createdAt: Date | null } },
  now: Date
): { readonly count: number; readonly oldestAgeMs: number | null; readonly rows: readonly TRow[] } {
  return {
    count: summary._count,
    oldestAgeMs: summary._min.createdAt === null
      ? null
      : Math.max(0, now.getTime() - summary._min.createdAt.getTime()),
    rows
  };
}

const CONTINUATION_SCHEMA = z.object({
  attemptBoundary: z.string().min(1).nullable(),
  before: z.string().min(1).nullable(),
  complete: z.boolean(),
  lastErrorCode: z.string().min(1).nullable(),
  matchedMessageIds: z.array(z.string().min(1)),
  pagesScanned: z.number().int().nonnegative(),
  status: z.enum(["ERROR", "MULTIPLE", "PARTIAL", "UNIQUE", "ZERO_COMPLETE", "ZERO_PARTIAL"]),
  version: z.literal(1)
}).strict();

export function createPrismaDiscordRemoteVerificationRepository(input: {
  readonly actor: DatabaseActor;
  readonly adminId: string;
  readonly ipHash: string;
  readonly now: Date;
}): DiscordRemoteVerificationRepository {
  const expectedTargets = new Map<string, { readonly attemptBoundary: string; readonly cursor: string | null }>();
  return {
    loadTarget: ({ expectedControlEpoch, expectedState, reservationId }) => withDatabaseContext({
      actor: input.actor,
      client: prisma,
      operation: async (transaction) => {
        const [control, message] = await Promise.all([
          transaction.discordOperationsControl.findUnique({
            select: { enabled: true, epoch: true, pendingRemoteCleanup: true },
            where: { id: "discord-operations" }
          }),
          transaction.discordReservationMessage.findUnique({
            include: { reservation: { select: { userId: true } } },
            where: { reservationId }
          })
        ]);
        if (message === null) return { kind: "not_found" };
        if (control?.enabled !== true) return { code: "disabled", kind: "conflict" };
        if (control.pendingRemoteCleanup) return { code: "draining", kind: "conflict" };
        if (control.epoch !== expectedControlEpoch) return { code: "stale_epoch", kind: "conflict" };
        const continuation = parseContinuation(message.remoteVerificationCursor);
        if (
          expectedState !== "PENDING_REVIEW"
          || message.initialSendStatus !== "PENDING_REVIEW"
          || message.postOperationEpoch !== expectedControlEpoch
          || message.channelId === null
          || message.postOperationBoundary === null
          || (continuation !== null && continuation.attemptBoundary !== message.postOperationBoundary)
        ) return { code: "stale_state", kind: "conflict" };
        expectedTargets.set(reservationId, {
          attemptBoundary: message.postOperationBoundary,
          cursor: message.remoteVerificationCursor
        });
        return {
          attemptBoundary: message.postOperationBoundary,
          channelId: message.channelId,
          continuation,
          kind: "ready",
          nonce: message.nonce
        };
      }
    }),
    saveProgress: ({ boundMessageId, continuation, expectedControlEpoch, reservationId }) => withDatabaseContext({
      actor: input.actor,
      client: prisma,
      operation: async (transaction) => {
        const [control] = await transaction.$queryRaw<readonly RemoteVerificationControlRow[]>(Prisma.sql`
          SELECT "enabled", "epoch", "pendingRemoteCleanup"
          FROM "DiscordOperationsControl"
          WHERE "id" = 'discord-operations'
          FOR SHARE
        `);
        const message = await transaction.discordReservationMessage.findUnique({
          include: { reservation: { select: { userId: true } } },
          where: { reservationId }
        });
        const expectedTarget = expectedTargets.get(reservationId);
        if (
          control?.enabled !== true
          || control.pendingRemoteCleanup
          || control.epoch !== expectedControlEpoch
          || message?.initialSendStatus !== "PENDING_REVIEW"
          || message.postOperationEpoch !== expectedControlEpoch
          || expectedTarget === undefined
          || message.postOperationBoundary !== expectedTarget.attemptBoundary
          || message.remoteVerificationCursor !== expectedTarget.cursor
          || continuation.attemptBoundary !== expectedTarget.attemptBoundary
        ) return false;
        const serialized = JSON.stringify(continuation);
        const updated = await transaction.discordReservationMessage.updateMany({
          data: {
            ...(boundMessageId === null ? {} : {
              initialSendNextAttemptAt: null,
              initialSendOutcome: "REMOTE_VERIFIED",
              initialSendStatus: "SENT",
              messageId: boundMessageId,
              pendingReviewReason: null,
              syncNextAttemptAt: input.now,
              syncStatus: "PENDING"
            }),
            remoteVerificationCursor: serialized,
            remoteVerificationNextAttemptAt: continuation.status === "ERROR"
              ? new Date(input.now.getTime() + 60_000)
              : null,
            remoteVerificationStatus: continuation.status
          },
          where: {
            initialSendStatus: "PENDING_REVIEW",
            postOperationBoundary: expectedTarget.attemptBoundary,
            postOperationEpoch: expectedControlEpoch,
            remoteVerificationCursor: expectedTarget.cursor,
            reservationId
          }
        });
        if (updated.count !== 1) return false;
        const action = await transaction.adminAction.create({
          data: {
            action: "DISCORD_RESERVATION_MESSAGE_REPAIR",
            actorId: input.adminId,
            after: JSON.stringify({
              boundMessageId,
              pagesScanned: continuation.pagesScanned,
              status: continuation.status
            }),
            before: JSON.stringify({ initialSendStatus: "PENDING_REVIEW" }),
            ipHash: input.ipHash,
            reason: "Discord 원격 메시지 확인",
            reservationId,
            targetUserId: message.reservation.userId
          }
        });
        await transaction.auditLog.create({
          data: {
            action: "DISCORD_RESERVATION_MESSAGE_REPAIR",
            actorId: input.adminId,
            detail: JSON.stringify({ actionId: action.id, operation: "verify_remote", reservationId }),
            userId: message.reservation.userId
          }
        });
        expectedTargets.set(reservationId, {
          attemptBoundary: expectedTarget.attemptBoundary,
          cursor: serialized
        });
        return true;
      }
    })
  };
}

type RemoteVerificationControlRow = {
  readonly enabled: boolean;
  readonly epoch: number;
  readonly pendingRemoteCleanup: boolean;
};

function parseContinuation(value: string | null): DiscordRemoteVerificationContinuation | null {
  if (value === null) return null;
  try {
    return CONTINUATION_SCHEMA.parse(JSON.parse(value));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new InvalidDiscordRemoteVerificationCursorError();
    }
    throw error;
  }
}

class InvalidDiscordRemoteVerificationCursorError extends Error {
  public constructor() {
    super("Stored Discord remote verification cursor is invalid");
    this.name = "InvalidDiscordRemoteVerificationCursorError";
  }
}

type RepairAction = "abandon" | "remove_controls" | "retry" | "sync";

export type DiscordReservationRepairResult =
  | { readonly auditActionId: string; readonly kind: "repaired" }
  | { readonly code: "disabled" | "draining" | "stale_epoch" | "stale_state"; readonly kind: "conflict" }
  | { readonly kind: "not_found" };

export async function repairDiscordReservationMessageWithPrisma(input: {
  readonly action: RepairAction;
  readonly actor: DatabaseActor;
  readonly adminId: string;
  readonly confirmation?: string;
  readonly expectedControlEpoch: number;
  readonly expectedState: string;
  readonly ipHash: string;
  readonly now: Date;
  readonly reservationId: string;
}): Promise<DiscordReservationRepairResult> {
  return withDatabaseContext({
    actor: input.actor,
    client: prisma,
    operation: async (transaction) => {
      const [control] = await transaction.$queryRaw<readonly RepairControlRow[]>(Prisma.sql`
        SELECT "enabled", "epoch", "pendingRemoteCleanup"
        FROM "DiscordOperationsControl"
        WHERE "id" = 'discord-operations'
        FOR SHARE
      `);
      const message = await transaction.discordReservationMessage.findUnique({
        include: { reservation: { select: { status: true, userId: true } } },
        where: { reservationId: input.reservationId }
      });
      if (message === null) return { kind: "not_found" };
      if (control?.enabled !== true) return { code: "disabled", kind: "conflict" };
      if (control.pendingRemoteCleanup) return { code: "draining", kind: "conflict" };
      if (control.epoch !== input.expectedControlEpoch) return { code: "stale_epoch", kind: "conflict" };
      if (!isEligible(message, input)) return { code: "stale_state", kind: "conflict" };

      const updated = await transaction.discordReservationMessage.updateMany({
        data: repairData(input),
        where: repairWhere(message, input)
      });
      if (updated.count !== 1) return { code: "stale_state", kind: "conflict" };
      const action = await transaction.adminAction.create({
        data: {
          action: "DISCORD_RESERVATION_MESSAGE_REPAIR",
          actorId: input.adminId,
          after: JSON.stringify({ action: input.action }),
          before: JSON.stringify({ state: input.expectedState }),
          ipHash: input.ipHash,
          reason: repairReason(input.action),
          reservationId: input.reservationId,
          targetUserId: message.reservation.userId
        }
      });
      await transaction.auditLog.create({
        data: {
          action: "DISCORD_RESERVATION_MESSAGE_REPAIR",
          actorId: input.adminId,
          detail: JSON.stringify({
            actionId: action.id,
            operation: input.action,
            reservationId: input.reservationId
          }),
          userId: message.reservation.userId
        }
      });
      return { auditActionId: action.id, kind: "repaired" };
    }
  });
}

type RepairableMessage = {
  readonly initialSendAttempts: number;
  readonly initialSendOutcome: string | null;
  readonly initialSendStatus: string;
  readonly messageId: string | null;
  readonly messageRevision: number;
  readonly postOperationEpoch: number | null;
  readonly remoteVerificationStatus: string | null;
  readonly renderedSourceEpoch: number;
  readonly reservation: { readonly status: string; readonly userId: string };
  readonly syncStatus: string;
  readonly syncedRevision: number;
};

type RepairControlRow = {
  readonly enabled: boolean;
  readonly epoch: number;
  readonly pendingRemoteCleanup: boolean;
};

function isEligible(
  message: RepairableMessage,
  input: {
    readonly action: RepairAction;
    readonly confirmation?: string;
    readonly expectedControlEpoch: number;
    readonly expectedState: string;
    readonly reservationId: string;
  }
): boolean {
  switch (input.action) {
    case "retry":
      return input.expectedState === message.initialSendStatus
        && (message.initialSendStatus === "FAILED" || message.initialSendStatus === "RETRY")
        && message.initialSendOutcome === "FAILED"
        && message.initialSendAttempts < 8;
    case "sync":
      return input.expectedState === syncState(message)
        && message.messageId !== null
        && message.messageRevision > message.syncedRevision
        && message.renderedSourceEpoch === input.expectedControlEpoch;
    case "remove_controls":
      return input.confirmation === input.reservationId
        && input.expectedState === syncState(message)
        && message.messageId !== null
        && (message.reservation.status === "CANCELLED" || message.reservation.status === "NO_SHOW")
        && message.renderedSourceEpoch === input.expectedControlEpoch;
    case "abandon":
      return input.confirmation === input.reservationId
        && input.expectedState === message.initialSendStatus
        && message.initialSendStatus === "PENDING_REVIEW"
        && canAbandonAfterRemoteVerification(message.remoteVerificationStatus);
    default:
      return assertNever(input.action);
  }
}

function repairData(input: { readonly action: RepairAction; readonly now: Date }) {
  switch (input.action) {
    case "retry":
      return {
        initialSendError: null,
        initialSendNextAttemptAt: input.now,
        initialSendOutcome: null,
        initialSendStatus: "PENDING"
      };
    case "sync":
      return { syncError: null, syncNextAttemptAt: input.now, syncStatus: "PENDING" };
    case "remove_controls":
      return {
        legacyControlState: "CLEANUP_PENDING",
        messageRevision: { increment: 1 },
        syncError: null,
        syncNextAttemptAt: input.now,
        syncStatus: "PENDING"
      };
    case "abandon":
      return {
        initialSendNextAttemptAt: null,
        initialSendStatus: "ABANDONED",
        pendingReviewReason: "OPERATOR_ABANDONED",
        syncNextAttemptAt: null,
        syncStatus: "ABANDONED"
      };
    default:
      return assertNever(input.action);
  }
}

function canAbandonAfterRemoteVerification(status: string | null): boolean {
  return status === "ERROR" || status === "MULTIPLE" || status === "ZERO_COMPLETE";
}

function repairWhere(message: RepairableMessage, input: {
  readonly action: RepairAction;
  readonly expectedControlEpoch: number;
  readonly reservationId: string;
}) {
  switch (input.action) {
    case "retry":
    case "abandon":
      return {
        initialSendStatus: message.initialSendStatus,
        postOperationEpoch: message.postOperationEpoch,
        reservationId: input.reservationId
      };
    case "sync":
    case "remove_controls":
      return {
        messageRevision: message.messageRevision,
        renderedSourceEpoch: input.expectedControlEpoch,
        reservationId: input.reservationId,
        syncStatus: message.syncStatus,
        syncedRevision: message.syncedRevision
      };
    default:
      return assertNever(input.action);
  }
}

function syncState(message: RepairableMessage): string {
  return `${message.syncStatus}:${message.messageRevision}:${message.syncedRevision}:${message.renderedSourceEpoch}`;
}

function repairReason(action: RepairAction): string {
  switch (action) {
    case "retry": return "Discord 메시지 재시도";
    case "sync": return "Discord 메시지 동기화";
    case "remove_controls": return "Discord 제어 제거";
    case "abandon": return "Discord 메시지 복구 종료";
    default: return assertNever(action);
  }
}

function assertNever(value: never): never {
  throw new DiscordReservationRepairVariantError(String(value));
}

class DiscordReservationRepairVariantError extends Error {
  public constructor(value: string) {
    super(`Unhandled Discord reservation repair action: ${value}`);
    this.name = "DiscordReservationRepairVariantError";
  }
}
