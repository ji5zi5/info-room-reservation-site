import { randomUUID } from "node:crypto";

import type { DiscordApplicationConfig } from "./discord-app-config";
import {
  createDiscordBotClient,
  type DiscordBotClient,
  type DiscordChannelHistoryClient,
  type DiscordChannelHistoryPageResult
} from "./discord-bot";
import type { DiscordRemoteVerificationContinuation } from "./discord-reservation-reconciliation";
import { parseServerEnv, ServerEnvError } from "./env";
import { prismaDiscordReservationMaintenanceRepository } from "./prisma-discord-reservation-maintenance-repository";
import { deleteExpiredInteractionJobs } from "./prisma-discord-reservation-message-cleanup";
import type { RetentionCleanupResult } from "./retention-policy";
import { prismaDiscordReservationMessageRepository } from "./prisma-discord-reservation-message-repository";
import {
  emitStructuredOperationalEvent,
  type StructuredOperationalEvent
} from "./structured-operational-log";

export type MaintenanceCleanupResult = {
  readonly backlogCount: number;
  readonly csrfTokensDeleted: number;
  readonly discordInteractionReceiptsDeleted: number;
  readonly discordInteractionJobsDeleted: number;
  readonly discordMessagesDeleted: number;
  readonly discordStages: DiscordMaintenanceStages;
  readonly expiredSanctionsRevoked: number;
  readonly rateLimitBucketsDeleted: number;
  readonly retention: RetentionCleanupResult;
  readonly restrictionsReleased: number;
  readonly sessionsDeleted: number;
};

export type MaintenanceExpiryBatchResult = {
  readonly failureCode?: string;
  readonly hasMore: boolean;
  readonly processedCount: number;
  readonly remainingLowerBound: number;
};

export type MaintenanceCleanupStore = {
  readonly applyRetentionPolicy: (now: Date) => Promise<RetentionCleanupResult>;
  readonly deleteExpiredCsrfTokens: (now: Date) => Promise<MaintenanceExpiryBatchResult>;
  readonly deleteExpiredRateLimitBuckets: (now: Date) => Promise<MaintenanceExpiryBatchResult>;
  readonly deleteExpiredSessions: (now: Date) => Promise<MaintenanceExpiryBatchResult>;
  readonly releaseExpiredRestrictions: (now: Date) => Promise<MaintenanceExpiryBatchResult>;
  readonly revokeExpiredSanctions: (now: Date) => Promise<MaintenanceExpiryBatchResult>;
};

export type DiscordMaintenanceCleanupStore = {
  readonly deleteExpiredInteractionJobs: (now: Date) => Promise<MaintenanceExpiryBatchResult>;
  readonly deleteExpiredInteractionReceipts: (now: Date) => Promise<MaintenanceExpiryBatchResult>;
  readonly deleteExpiredMessages: (
    now: Date,
    context?: MaintenanceLogContext
  ) => Promise<MaintenanceExpiryBatchResult>;
};

type MaintenanceLogContext = {
  readonly log: (event: StructuredOperationalEvent) => void;
  readonly runId: string;
};

export type DiscordMaintenanceStageResult = {
  readonly backlogCount: number;
  readonly failureCode: string | null;
  readonly processedCount: number;
};

export type DiscordMaintenanceStages = {
  readonly interactionJobs: DiscordMaintenanceStageResult;
  readonly interactionReceipts: DiscordMaintenanceStageResult;
  readonly messages: DiscordMaintenanceStageResult;
};

export type DiscordMessageRetentionCandidate = {
  readonly attemptBoundary: string | null;
  readonly channelId: string | null;
  readonly continuation: DiscordRemoteVerificationContinuation | null;
  readonly kind: "known" | "local" | "unknown";
  readonly messageId: string | null;
  readonly nonce: string;
  readonly reservationId: string;
  readonly updatedAt: Date;
};

export type DiscordMessageRetentionRepository = {
  readonly deleteLocalCandidate: (candidate: DiscordMessageRetentionCandidate, now: Date) => Promise<boolean>;
  readonly findExpiredCandidates: (now: Date) => Promise<readonly DiscordMessageRetentionCandidate[]>;
  readonly reduceToDeletionTombstone: (input: {
    readonly candidate: DiscordMessageRetentionCandidate;
    readonly matchCount: number;
    readonly now: Date;
    readonly outcome: "KNOWN" | "MULTIPLE" | "UNIQUE";
  }) => Promise<boolean>;
  readonly saveScanProgress: (
    candidate: DiscordMessageRetentionCandidate,
    continuation: DiscordRemoteVerificationContinuation,
    now: Date
  ) => Promise<boolean>;
};

const MAX_EXPIRY_BATCHES = 10;
const DISCORD_RETENTION_BATCH_SIZE = 100;
const DISCORD_RETENTION_PAGE_SIZE = 100;
const DISCORD_RETENTION_SCAN_PAGE_CAP = 10;

export async function runMaintenanceCleanup(input: {
  readonly discordStore?: DiscordMaintenanceCleanupStore;
  readonly log?: (event: StructuredOperationalEvent) => void;
  readonly now: Date;
  readonly runId?: string;
  readonly store: MaintenanceCleanupStore;
}): Promise<MaintenanceCleanupResult> {
  const discordStore = input.discordStore ?? defaultDiscordMaintenanceStore();
  const runId = input.runId ?? randomUUID();
  const log = input.log ?? emitStructuredOperationalEvent;
  const discordMessages = await runDiscordStage({
    failureCode: "discord_messages_cleanup_failed",
    job: () => discordStore.deleteExpiredMessages(input.now, { log, runId }),
    log,
    runId,
    stage: "discord_messages"
  });
  const discordJobs = await runDiscordStage({
    failureCode: "discord_interaction_jobs_cleanup_failed",
    job: () => discordStore.deleteExpiredInteractionJobs(input.now),
    log,
    runId,
    stage: "discord_interaction_jobs"
  });
  const discordReceipts = await runDiscordStage({
    failureCode: "discord_interaction_receipts_cleanup_failed",
    job: () => discordStore.deleteExpiredInteractionReceipts(input.now),
    log,
    runId,
    stage: "discord_interaction_receipts"
  });
  const sessions = await drainExpiryBatches(() => input.store.deleteExpiredSessions(input.now));
  const csrfTokens = await drainExpiryBatches(() => input.store.deleteExpiredCsrfTokens(input.now));
  const rateLimitBuckets = await drainExpiryBatches(() => input.store.deleteExpiredRateLimitBuckets(input.now));
  const restrictions = await drainExpiryBatches(() => input.store.releaseExpiredRestrictions(input.now));
  const expiredSanctions = await drainExpiryBatches(() => input.store.revokeExpiredSanctions(input.now));
  const retention = await input.store.applyRetentionPolicy(input.now);

  return {
    backlogCount:
      sessions.remainingLowerBound +
      discordMessages.backlogCount +
      discordJobs.backlogCount +
      discordReceipts.backlogCount +
      csrfTokens.remainingLowerBound +
      rateLimitBuckets.remainingLowerBound +
      restrictions.remainingLowerBound +
      expiredSanctions.remainingLowerBound,
    csrfTokensDeleted: csrfTokens.processedCount,
    discordInteractionJobsDeleted: discordJobs.processedCount,
    discordInteractionReceiptsDeleted: discordReceipts.processedCount,
    discordMessagesDeleted: discordMessages.processedCount,
    discordStages: {
      interactionJobs: discordJobs,
      interactionReceipts: discordReceipts,
      messages: discordMessages
    },
    expiredSanctionsRevoked: expiredSanctions.processedCount,
    rateLimitBucketsDeleted: rateLimitBuckets.processedCount,
    retention,
    restrictionsReleased: restrictions.processedCount,
    sessionsDeleted: sessions.processedCount
  };
}

async function runDiscordStage(input: {
  readonly failureCode: string;
  readonly job: () => Promise<MaintenanceExpiryBatchResult>;
  readonly log: (event: StructuredOperationalEvent) => void;
  readonly runId: string;
  readonly stage: string;
}): Promise<DiscordMaintenanceStageResult> {
  const startedAt = Date.now();
  try {
    const result = await drainExpiryBatches(input.job);
    const stage = {
      backlogCount: result.remainingLowerBound,
      failureCode: result.failureCode,
      processedCount: result.processedCount
    };
    input.log({
      durationMs: Date.now() - startedAt,
      errorCode: stage.failureCode,
      event: "maintenance.stage",
      jobId: "MAINTENANCE",
      result: stage.backlogCount > 0 ? "blocked" : "succeeded",
      runId: input.runId,
      stage: input.stage
    });
    return stage;
  } catch {
    const stage = { backlogCount: 1, failureCode: input.failureCode, processedCount: 0 };
    input.log({
      durationMs: Date.now() - startedAt,
      errorCode: input.failureCode,
      event: "maintenance.stage",
      jobId: "MAINTENANCE",
      result: "failed",
      runId: input.runId,
      stage: input.stage
    });
    return stage;
  }
}

async function drainExpiryBatches(
  expireBatch: () => Promise<MaintenanceExpiryBatchResult>
): Promise<{ readonly failureCode: string | null; readonly processedCount: number; readonly remainingLowerBound: number }> {
  let processedCount = 0;
  for (let batchNumber = 0; batchNumber < MAX_EXPIRY_BATCHES; batchNumber += 1) {
    const batch = await expireBatch();
    processedCount += batch.processedCount;
    const failureCode = batch.failureCode ?? null;
    if (failureCode !== null) {
      return { failureCode, processedCount, remainingLowerBound: Math.max(1, batch.remainingLowerBound) };
    }
    if (!batch.hasMore) {
      return { failureCode: null, processedCount, remainingLowerBound: batch.remainingLowerBound };
    }
    if (batchNumber === MAX_EXPIRY_BATCHES - 1) {
      return { failureCode: null, processedCount, remainingLowerBound: batch.remainingLowerBound };
    }
  }
  return { failureCode: null, processedCount, remainingLowerBound: 0 };
}

export function createDiscordMessageRetentionCleanup(dependencies: {
  readonly hasApplicationConfig: () => boolean;
  readonly history: DiscordChannelHistoryClient;
  readonly log?: (event: StructuredOperationalEvent) => void;
  readonly repository: DiscordMessageRetentionRepository;
  readonly transport: Pick<DiscordBotClient, "deleteChannelMessage">;
}): (
  now: Date,
  context?: MaintenanceLogContext
) => Promise<MaintenanceExpiryBatchResult & { readonly failureCode?: string }> {
  return async (now, context) => {
    const runId = context?.runId ?? randomUUID();
    const log = context?.log ?? dependencies.log ?? emitStructuredOperationalEvent;
    const candidates = await dependencies.repository.findExpiredCandidates(now);
    const selected = candidates.slice(0, DISCORD_RETENTION_BATCH_SIZE);
    const outcomes = [];
    for (const candidate of selected) {
      const startedAt = Date.now();
      const errorCode = await retainCandidate(candidate, now, dependencies);
      outcomes.push(errorCode);
      log({
        durationMs: Date.now() - startedAt,
        errorCode,
        event: "maintenance.reservation",
        jobId: "MAINTENANCE",
        reservationId: candidate.reservationId,
        result: errorCode === null ? "succeeded" : "blocked",
        runId,
        stage: "discord_messages"
      });
    }
    const failure = outcomes.find((outcome) => outcome !== null) ?? null;
    const failedCount = outcomes.filter((outcome) => outcome !== null).length;
    const hasAdditional = candidates.length > DISCORD_RETENTION_BATCH_SIZE;
    return {
      ...(failure === null ? {} : { failureCode: failure }),
      hasMore: hasAdditional && failedCount === 0,
      processedCount: selected.length - failedCount,
      remainingLowerBound: failedCount + (hasAdditional ? 1 : 0)
    };
  };
}

async function retainCandidate(
  candidate: DiscordMessageRetentionCandidate,
  now: Date,
  dependencies: Parameters<typeof createDiscordMessageRetentionCleanup>[0]
): Promise<string | null> {
  switch (candidate.kind) {
    case "local":
      return await dependencies.repository.deleteLocalCandidate(candidate, now)
        ? null
        : "discord_retention_ledger_conflict";
    case "known":
      if (!dependencies.hasApplicationConfig() || candidate.channelId === null || candidate.messageId === null) {
        return "discord_retention_lookup_incomplete";
      }
      return deleteMatchesAndReduce({ candidate, dependencies, messageIds: [candidate.messageId], now, outcome: "KNOWN" });
    case "unknown":
      return scanUnknownCandidate(candidate, now, dependencies);
    default:
      return assertNever(candidate.kind);
  }
}

async function scanUnknownCandidate(
  candidate: DiscordMessageRetentionCandidate,
  now: Date,
  dependencies: Parameters<typeof createDiscordMessageRetentionCleanup>[0]
): Promise<string | null> {
  if (!dependencies.hasApplicationConfig() || candidate.channelId === null || candidate.attemptBoundary === null) {
    const saved = await dependencies.repository.saveScanProgress(candidate, {
      ...(candidate.continuation ?? initialContinuation(candidate.attemptBoundary)),
      complete: false,
      lastErrorCode: "discord_retention_lookup_incomplete",
      status: "ERROR"
    }, now);
    return saved ? "discord_retention_lookup_incomplete" : "discord_retention_ledger_conflict";
  }
  const previous = candidate.continuation ?? initialContinuation(candidate.attemptBoundary);
  if (previous.complete) {
    if (previous.matchedMessageIds.length === 0) return "discord_retention_zero_match";
    const outcome = previous.matchedMessageIds.length === 1 ? "UNIQUE" : "MULTIPLE";
    return deleteMatchesAndReduce({
      candidate,
      continuation: previous,
      dependencies,
      messageIds: previous.matchedMessageIds,
      now,
      outcome
    });
  }
  if (previous.pagesScanned >= DISCORD_RETENTION_SCAN_PAGE_CAP && !previous.complete) {
    return "discord_retention_scan_cap";
  }
  const page = await dependencies.history.listChannelMessagesPage({
    ...(previous.before === null ? {} : { before: previous.before }),
    channelId: candidate.channelId,
    limit: DISCORD_RETENTION_PAGE_SIZE
  });
  return processHistoryPage({ candidate, dependencies, now, page, previous });
}

async function processHistoryPage(input: {
  readonly candidate: DiscordMessageRetentionCandidate;
  readonly dependencies: Parameters<typeof createDiscordMessageRetentionCleanup>[0];
  readonly now: Date;
  readonly page: DiscordChannelHistoryPageResult;
  readonly previous: DiscordRemoteVerificationContinuation;
}): Promise<string | null> {
  const { candidate, dependencies, now, page, previous } = input;
  switch (page.kind) {
    case "found": {
      const boundaryIndex = page.messages.findIndex((message) => message.id === previous.attemptBoundary);
      const relevant = boundaryIndex < 0 ? page.messages : page.messages.slice(0, boundaryIndex);
      const matches = [...new Set([
        ...previous.matchedMessageIds,
        ...relevant.filter((message) => message.nonce === candidate.nonce).map((message) => message.id)
      ])];
      const complete = boundaryIndex >= 0 || page.messages.length < DISCORD_RETENTION_PAGE_SIZE;
      const status = verificationStatus(complete, matches.length);
      const continuation: DiscordRemoteVerificationContinuation = {
        attemptBoundary: previous.attemptBoundary,
        before: relevant.at(-1)?.id ?? previous.before,
        complete,
        lastErrorCode: null,
        matchedMessageIds: matches,
        pagesScanned: previous.pagesScanned + 1,
        status,
        version: 1
      };
      if (!complete || matches.length === 0) {
        const saved = await dependencies.repository.saveScanProgress(candidate, continuation, now);
        if (!saved) return "discord_retention_ledger_conflict";
        return !complete && continuation.pagesScanned >= DISCORD_RETENTION_SCAN_PAGE_CAP
          ? "discord_retention_scan_cap"
          : complete ? "discord_retention_zero_match" : "discord_retention_scan_partial";
      }
      const outcome = matches.length === 1 ? "UNIQUE" : "MULTIPLE";
      return deleteMatchesAndReduce({ candidate, continuation, dependencies, messageIds: matches, now, outcome });
    }
    case "retryable_failure":
    case "terminal_failure": {
      const saved = await dependencies.repository.saveScanProgress(candidate, {
        ...previous,
        complete: false,
        lastErrorCode: page.code,
        status: "ERROR"
      }, now);
      return saved ? page.code : "discord_retention_ledger_conflict";
    }
    default:
      return assertNever(page);
  }
}

async function deleteMatchesAndReduce(input: {
  readonly candidate: DiscordMessageRetentionCandidate;
  readonly continuation?: DiscordRemoteVerificationContinuation;
  readonly dependencies: Parameters<typeof createDiscordMessageRetentionCleanup>[0];
  readonly messageIds: readonly string[];
  readonly now: Date;
  readonly outcome: "KNOWN" | "MULTIPLE" | "UNIQUE";
}): Promise<string | null> {
  const { candidate, continuation, dependencies, messageIds, now, outcome } = input;
  if (candidate.channelId === null) return "discord_retention_lookup_incomplete";
  for (const messageId of messageIds) {
    const deleted = await dependencies.transport.deleteChannelMessage({ channelId: candidate.channelId, messageId });
    if (deleted.kind === "failed") {
      if (continuation !== undefined) {
        const saved = await dependencies.repository.saveScanProgress(candidate, {
          ...continuation,
          lastErrorCode: deleted.code
        }, now);
        if (!saved) return "discord_retention_ledger_conflict";
      }
      return deleted.code;
    }
  }
  return await dependencies.repository.reduceToDeletionTombstone({
    candidate,
    matchCount: messageIds.length,
    now,
    outcome
  })
    ? null
    : "discord_retention_ledger_conflict";
}

function initialContinuation(attemptBoundary: string | null): DiscordRemoteVerificationContinuation {
  return {
    attemptBoundary,
    before: null,
    complete: false,
    lastErrorCode: null,
    matchedMessageIds: [],
    pagesScanned: 0,
    status: "ZERO_PARTIAL",
    version: 1
  };
}

function verificationStatus(
  complete: boolean,
  matchCount: number
): DiscordRemoteVerificationContinuation["status"] {
  if (!complete) return matchCount === 0 ? "ZERO_PARTIAL" : "PARTIAL";
  if (matchCount === 0) return "ZERO_COMPLETE";
  return matchCount === 1 ? "UNIQUE" : "MULTIPLE";
}

function defaultDiscordMaintenanceStore(): DiscordMaintenanceCleanupStore {
  let config: DiscordApplicationConfig | null | undefined;
  const getConfig = (): DiscordApplicationConfig | null => {
    if (config !== undefined) {
      return config;
    }
    try {
      config = parseServerEnv().discordApplication;
    } catch (error) {
      if (!(error instanceof ServerEnvError)) {
        throw error;
      }
      config = null;
    }
    return config;
  };
  const bot = {
    deleteChannelMessage: (message) => {
      const current = getConfig();
      if (current === null) {
        return Promise.resolve({
          code: "discord_application_unavailable",
          kind: "failed",
          message: "Discord application configuration is unavailable"
        });
      }
      return createDiscordBotClient({ applicationId: current.applicationId, botToken: current.botToken })
        .deleteChannelMessage(message);
    },
    listChannelMessagesPage: (message) => {
      const current = getConfig();
      if (current === null) {
        return Promise.resolve({ code: "discord_application_unavailable", kind: "terminal_failure" as const });
      }
      return createDiscordBotClient({ applicationId: current.applicationId, botToken: current.botToken })
        .listChannelMessagesPage(message);
    }
  } satisfies Pick<DiscordBotClient, "deleteChannelMessage"> & DiscordChannelHistoryClient;
  return {
    deleteExpiredInteractionJobs,
    deleteExpiredInteractionReceipts: (now) =>
      prismaDiscordReservationMessageRepository.deleteExpiredInteractionReceipts(now),
    deleteExpiredMessages: createDiscordMessageRetentionCleanup({
      hasApplicationConfig: () => getConfig() !== null,
      history: bot,
      repository: prismaDiscordReservationMaintenanceRepository,
      transport: bot
    })
  };
}

function assertNever(value: never): never {
  throw new MaintenanceVariantError(String(value));
}

class MaintenanceVariantError extends Error {
  public constructor(value: string) {
    super(`Unhandled maintenance variant: ${value}`);
    this.name = "MaintenanceVariantError";
  }
}
