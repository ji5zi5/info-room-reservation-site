import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MessageModel = {
  readonly aggregate: ReturnType<typeof vi.fn>;
  readonly create: ReturnType<typeof vi.fn>;
  readonly deleteMany: ReturnType<typeof vi.fn>;
  readonly findMany: ReturnType<typeof vi.fn>;
  readonly findUnique: ReturnType<typeof vi.fn>;
  readonly updateMany: ReturnType<typeof vi.fn<(
    input: Prisma.DiscordReservationMessageUpdateManyArgs
  ) => Promise<Prisma.BatchPayload>>>;
};

type ReceiptRow = { readonly terminalResult: Prisma.JsonValue };
type ReceiptModel = {
  readonly createMany: ReturnType<typeof vi.fn<(
    input: Prisma.DiscordInteractionReceiptCreateManyArgs
  ) => Promise<Prisma.BatchPayload>>>;
  readonly deleteMany: ReturnType<typeof vi.fn>;
  readonly findMany: ReturnType<typeof vi.fn>;
  readonly findUnique: ReturnType<typeof vi.fn<(
    input: Prisma.DiscordInteractionReceiptFindUniqueArgs
  ) => Promise<ReceiptRow | null>>>;
};

const repositoryMocks = vi.hoisted(() => {
  const messageModel = (): MessageModel => ({
    aggregate: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn()
  });
  const receiptModel = (): ReceiptModel => ({
    createMany: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn()
  });
  const transaction = {
    $queryRaw: vi.fn(),
    adminAction: { create: vi.fn(), findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
    discordInteractionJob: { aggregate: vi.fn(), findMany: vi.fn() },
    discordInteractionReceipt: receiptModel(),
    discordOperationsControl: { findUnique: vi.fn() },
    discordReservationMessage: messageModel(),
    operationalJob: { findMany: vi.fn() }
  };
  return {
    transaction,
    withDatabaseContext: vi.fn(async (input: {
      readonly operation: (value: typeof transaction) => Promise<unknown>;
    }) => input.operation(transaction))
  };
});

vi.mock("./db", () => ({ prisma: { kind: "prisma" } }));
vi.mock("./db-context", () => ({
  systemDatabaseActor: () => ({ id: null, role: "SYSTEM" }),
  withDatabaseContext: repositoryMocks.withDatabaseContext
}));

import {
  verifyRemoteDiscordReservationMessage,
  type DiscordRemoteVerificationContinuation,
  type DiscordRemoteVerificationRepository
} from "./discord-reservation-reconciliation";
import {
  createPrismaDiscordRemoteVerificationRepository,
  getDiscordOperationsBacklog,
  isDiscordSyncBacklog,
  repairDiscordReservationMessageWithPrisma
} from "./prisma-discord-reservation-message-repository";

const repositoryNow = new Date("2026-08-13T00:00:00.000Z");
const actor = { id: "admin-1", role: "ADMIN" } as const;

function resetRepositoryMocks(): void {
  vi.clearAllMocks();
  repositoryMocks.transaction.$queryRaw.mockResolvedValue([{
    enabled: true,
    epoch: 7,
    pendingRemoteCleanup: false
  }]);
  repositoryMocks.transaction.discordReservationMessage.findMany.mockResolvedValue([]);
  repositoryMocks.transaction.discordReservationMessage.aggregate.mockResolvedValue({
    _count: 0,
    _min: { createdAt: null }
  });
  repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 0 });
  repositoryMocks.transaction.discordReservationMessage.deleteMany.mockResolvedValue({ count: 0 });
  repositoryMocks.transaction.discordInteractionReceipt.findMany.mockResolvedValue([]);
  repositoryMocks.transaction.discordInteractionReceipt.deleteMany.mockResolvedValue({ count: 0 });
  repositoryMocks.transaction.discordInteractionJob.findMany.mockResolvedValue([]);
  repositoryMocks.transaction.discordInteractionJob.aggregate.mockResolvedValue({
    _count: 0,
    _min: { createdAt: null }
  });
  repositoryMocks.transaction.operationalJob.findMany.mockResolvedValue([]);
}

describe("Discord reservation message reconciliation", () => {
  it("resumes a persisted one-page scan after process loss and binds the unique nonce match", async () => {
    // Given: the first process finds the nonce on a full page and persists a before cursor.
    let continuation: DiscordRemoteVerificationContinuation | null = null;
    let boundMessageId: string | null = null;
    const repository: DiscordRemoteVerificationRepository = {
      loadTarget: async () => ({
        attemptBoundary: "post-boundary-1",
        channelId: "channel-1",
        continuation,
        kind: "ready",
        nonce: "nonce-1"
      }),
      saveProgress: async (input) => {
        continuation = input.continuation;
        boundMessageId = input.boundMessageId;
        return true;
      }
    };
    const pages = [
      [
        { id: "message-9", nonce: "nonce-other" },
        { id: "message-8", nonce: "nonce-1" }
      ],
      [{ id: "message-7", nonce: null }]
    ] as const;
    let pageIndex = 0;
    const listChannelMessagesPage = async () => ({
      kind: "found" as const,
      messages: pages[pageIndex++] ?? []
    });

    // When: two separate invocations each perform one bounded history request.
    const first = await verifyRemoteDiscordReservationMessage({
      expectedControlEpoch: 7,
      expectedState: "PENDING_REVIEW",
      pageSize: 2,
      repository,
      reservationId: "reservation-1",
      transport: { listChannelMessagesPage }
    });
    const second = await verifyRemoteDiscordReservationMessage({
      expectedControlEpoch: 7,
      expectedState: "PENDING_REVIEW",
      pageSize: 2,
      repository,
      reservationId: "reservation-1",
      transport: { listChannelMessagesPage }
    });

    // Then: progress survives process loss and the exact remote message is bound once complete.
    expect(first).toEqual({ kind: "unresolved", status: "PARTIAL" });
    expect(second).toEqual({ kind: "bound", messageId: "message-8" });
    expect(pageIndex).toBe(2);
    expect(boundMessageId).toBe("message-8");
    expect(continuation).toMatchObject({
      attemptBoundary: "post-boundary-1",
      before: "message-7",
      complete: true,
      matchedMessageIds: ["message-8"],
      pagesScanned: 2
    });
  });

  it("preserves the persisted POST boundary instead of deriving it from history IDs", async () => {
    // Given: Todo 1 recorded the original POST boundary before the process was lost.
    let saved: DiscordRemoteVerificationContinuation | null = null;
    const repository: DiscordRemoteVerificationRepository = {
      loadTarget: async () => ({
        attemptBoundary: "post-boundary-1",
        channelId: "channel-1",
        continuation: null,
        kind: "ready",
        nonce: "nonce-1"
      }),
      saveProgress: async (input) => {
        saved = input.continuation;
        return true;
      }
    };

    // When: Discord history begins at a different remote message ID.
    const result = await verifyRemoteDiscordReservationMessage({
      expectedControlEpoch: 7,
      expectedState: "PENDING_REVIEW",
      pageSize: 2,
      repository,
      reservationId: "reservation-1",
      transport: {
        listChannelMessagesPage: async () => ({
          kind: "found",
          messages: [{ id: "history-message-9", nonce: "nonce-other" }]
        })
      }
    });

    // Then: continuation retains the original attempt boundary through the first durable save.
    expect(result).toEqual({ kind: "unresolved", status: "ZERO_COMPLETE" });
    expect(saved).toMatchObject({ attemptBoundary: "post-boundary-1" });
  });

  it.each([
    [[], "ZERO_COMPLETE"],
    [[{ id: "message-2", nonce: "nonce-1" }, { id: "message-1", nonce: "nonce-1" }], "MULTIPLE"]
  ] as const)("keeps a complete %s match scan unresolved as %s", async (messages, expectedStatus) => {
    // Given: Discord completes a page with zero or multiple exact nonce matches.
    let saved: Parameters<DiscordRemoteVerificationRepository["saveProgress"]>[0] | null = null;
    const repository: DiscordRemoteVerificationRepository = {
      loadTarget: async () => ({ attemptBoundary: "post-boundary-1", channelId: "channel-1", continuation: null, kind: "ready", nonce: "nonce-1" }),
      saveProgress: async (input) => {
        saved = input;
        return true;
      }
    };

    // When: one complete page is verified.
    const result = await verifyRemoteDiscordReservationMessage({
      expectedControlEpoch: 7,
      expectedState: "PENDING_REVIEW",
      pageSize: 3,
      repository,
      reservationId: "reservation-1",
      transport: { listChannelMessagesPage: async () => ({ kind: "found", messages }) }
    });

    // Then: no message is bound and the nonce evidence remains persisted for review.
    expect(result).toEqual({ kind: "unresolved", status: expectedStatus });
    expect(saved).toMatchObject({
      boundMessageId: null,
      continuation: { complete: true, status: expectedStatus }
    });
  });

  it.each(["discord_http_429", "discord_http_500"])(
    "persists the same cursor after %s so a later invocation resumes without restarting",
    async (code) => {
      // Given: a prior page is durable and Discord temporarily refuses the next page.
      const prior: DiscordRemoteVerificationContinuation = {
        attemptBoundary: "message-9",
        before: "message-8",
        complete: false,
        lastErrorCode: null,
        matchedMessageIds: [],
        pagesScanned: 1,
        status: "ZERO_PARTIAL",
        version: 1
      };
      let saved: DiscordRemoteVerificationContinuation | null = null;
      const repository: DiscordRemoteVerificationRepository = {
        loadTarget: async () => ({ attemptBoundary: "post-boundary-1", channelId: "channel-1", continuation: prior, kind: "ready", nonce: "nonce-1" }),
        saveProgress: async (input) => {
          saved = input.continuation;
          return true;
        }
      };
      const requestedBefore: (string | undefined)[] = [];

      // When: the bounded transport returns a retryable Discord response.
      const result = await verifyRemoteDiscordReservationMessage({
        expectedControlEpoch: 7,
        expectedState: "PENDING_REVIEW",
        repository,
        reservationId: "reservation-1",
        transport: {
          listChannelMessagesPage: async (input) => {
            requestedBefore.push(input.before);
            return { code, kind: "retryable_failure" };
          }
        }
      });

      // Then: no page is counted or cursor advanced, while the safe error code is durable.
      expect(result).toEqual({ kind: "unresolved", status: "ERROR" });
      expect(requestedBefore).toEqual(["message-8"]);
      expect(saved).toEqual({ ...prior, complete: false, lastErrorCode: code, status: "ERROR" });
    }
  );

  it("rejects a stale verification epoch before any Discord request", async () => {
    const listChannelMessagesPage = async () => ({ kind: "found" as const, messages: [] });
    let transportCalls = 0;

    const result = await verifyRemoteDiscordReservationMessage({
      expectedControlEpoch: 7,
      expectedState: "PENDING_REVIEW",
      repository: {
        loadTarget: async () => ({ code: "stale_epoch", kind: "conflict" }),
        saveProgress: async () => false
      },
      reservationId: "reservation-1",
      transport: {
        listChannelMessagesPage: async (input) => {
          transportCalls += 1;
          void input;
          return listChannelMessagesPage();
        }
      }
    });

    expect(result).toEqual({ kind: "conflict" });
    expect(transportCalls).toBe(0);
  });
});

describe("Prisma Discord operations repository", () => {
  beforeEach(resetRepositoryMocks);

  it("returns bounded rows with independent count and oldest-age aggregates for all three backlog classes", async () => {
    // Given: each backlog has more aggregate work than its bounded visible rows.
    repositoryMocks.transaction.discordInteractionJob.findMany.mockResolvedValue([{ interactionId: "job-1" }]);
    repositoryMocks.transaction.discordInteractionJob.aggregate.mockResolvedValue({
      _count: 12,
      _min: { createdAt: new Date("2026-08-12T22:00:00.000Z") }
    });
    repositoryMocks.transaction.discordReservationMessage.findMany
      .mockResolvedValueOnce([{ reservationId: "initial-1" }])
      .mockResolvedValueOnce([{ messageId: "message-sync-1", reservationId: "sync-1", syncStatus: "RETRY" }]);
    repositoryMocks.transaction.discordReservationMessage.aggregate
      .mockResolvedValueOnce({
        _count: 8,
        _min: { createdAt: new Date("2026-08-12T23:00:00.000Z") }
      })
      .mockResolvedValueOnce({
        _count: 5,
        _min: { createdAt: new Date("2026-08-12T23:30:00.000Z") }
      });

    // When: the operations route repository reads a five-row window.
    const result = await getDiscordOperationsBacklog({ actor, limit: 5, now: repositoryNow });

    // Then: rows stay bounded while aggregate truth is preserved independently.
    expect(result.interactions).toMatchObject({ count: 12, oldestAgeMs: 7_200_000, rows: [{ interactionId: "job-1" }] });
    expect(result.initialSends).toMatchObject({ count: 8, oldestAgeMs: 3_600_000, rows: [{ reservationId: "initial-1" }] });
    expect(result.syncs).toMatchObject({ count: 5, oldestAgeMs: 1_800_000, rows: [{ reservationId: "sync-1" }] });
    expect(repositoryMocks.transaction.discordInteractionJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 })
    );
    expect(repositoryMocks.transaction.discordReservationMessage.findMany).toHaveBeenCalledTimes(2);
    expect(repositoryMocks.withDatabaseContext).toHaveBeenCalledWith(expect.objectContaining({ actor }));
  });

  it("excludes a fully synced revision while retaining a truly stale sync row", () => {
    // Given: one delivered revision and one later revision waiting for a sync.
    const fullySynced = { messageId: "message-1", messageRevision: 1, syncStatus: "SYNCED", syncedRevision: 1 } as const;
    const stale = { messageId: "message-2", messageRevision: 2, syncStatus: "PENDING", syncedRevision: 1 } as const;

    // When: the repository backlog contract classifies both rows.
    const rows = [fullySynced, stale].filter(isDiscordSyncBacklog);

    // Then: only work that still needs reconciliation remains visible and countable.
    expect(rows).toEqual([stale]);
  });

  it("persists verification continuation and unique binding with current epoch and row-state CAS", async () => {
    // Given: an admin-scoped repository sees the current control and pending-review target.
    repositoryMocks.transaction.discordOperationsControl.findUnique.mockResolvedValue({
      enabled: true,
      epoch: 7,
      pendingRemoteCleanup: false
    });
    repositoryMocks.transaction.discordReservationMessage.findUnique.mockResolvedValue({
      channelId: "channel-1",
      initialSendStatus: "PENDING_REVIEW",
      nonce: "nonce-1",
      postOperationBoundary: "post-boundary",
      postOperationEpoch: 7,
      remoteVerificationCursor: null,
      reservation: { userId: "user-1" },
      reservationId: "reservation-1"
    });
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });
    repositoryMocks.transaction.adminAction.create.mockResolvedValue({ id: "action-1" });
    const repository = createPrismaDiscordRemoteVerificationRepository({
      actor,
      adminId: "admin-1",
      ipHash: "ip-hash",
      now: repositoryNow
    });
    const target = await repository.loadTarget({
      expectedControlEpoch: 7,
      expectedState: "PENDING_REVIEW",
      reservationId: "reservation-1"
    });

    // When: a completed unique scan is conditionally persisted.
    const saved = await repository.saveProgress({
      boundMessageId: "message-1",
      continuation: {
        attemptBoundary: "post-boundary",
        before: "message-1",
        complete: true,
        lastErrorCode: null,
        matchedMessageIds: ["message-1"],
        pagesScanned: 2,
        status: "UNIQUE",
        version: 1
      },
      expectedControlEpoch: 7,
      reservationId: "reservation-1"
    });

    // Then: the nonce remains, the exact message binds, and one action/audit pair records the winning CAS.
    expect(target).toMatchObject({ attemptBoundary: "post-boundary", channelId: "channel-1", nonce: "nonce-1" });
    expect(saved).toBe(true);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ messageId: "message-1", remoteVerificationStatus: "UNIQUE" }),
        where: expect.objectContaining({
          initialSendStatus: "PENDING_REVIEW",
          postOperationEpoch: 7,
          reservationId: "reservation-1"
        })
      })
    );
    expect(repositoryMocks.transaction.adminAction.create).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.transaction.auditLog.create).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.withDatabaseContext).toHaveBeenCalledWith(expect.objectContaining({ actor }));
  });

  it.each([
    ["missing", null],
    ["mismatched", JSON.stringify({
      attemptBoundary: "history-message-9",
      before: "history-message-8",
      complete: false,
      lastErrorCode: null,
      matchedMessageIds: [],
      pagesScanned: 1,
      status: "ZERO_PARTIAL",
      version: 1
    })]
  ] as const)("rejects a %s persisted POST boundary before remote verification", async (_boundaryKind, remoteVerificationCursor) => {
    // Given: the local message either lost its POST boundary or carries a continuation from another attempt.
    repositoryMocks.transaction.discordOperationsControl.findUnique.mockResolvedValue({
      enabled: true,
      epoch: 7,
      pendingRemoteCleanup: false
    });
    repositoryMocks.transaction.discordReservationMessage.findUnique.mockResolvedValue({
      channelId: "channel-1",
      initialSendStatus: "PENDING_REVIEW",
      nonce: "nonce-1",
      postOperationBoundary: remoteVerificationCursor === null ? null : "post-boundary-1",
      postOperationEpoch: 7,
      remoteVerificationCursor,
      reservation: { userId: "user-1" },
      reservationId: "reservation-1"
    });
    const repository = createPrismaDiscordRemoteVerificationRepository({
      actor,
      adminId: "admin-1",
      ipHash: "ip-hash",
      now: repositoryNow
    });

    // When: remote verification asks to load the target.
    const result = await repository.loadTarget({
      expectedControlEpoch: 7,
      expectedState: "PENDING_REVIEW",
      reservationId: "reservation-1"
    });

    // Then: Discord history is never queried with a missing or foreign POST boundary.
    expect(result).toEqual({ code: "stale_state", kind: "conflict" });
  });

  it("does not audit a verification save that loses its current-row CAS", async () => {
    // Given: loading succeeds but another process changes the row before persistence.
    repositoryMocks.transaction.discordOperationsControl.findUnique.mockResolvedValue({
      enabled: true,
      epoch: 7,
      pendingRemoteCleanup: false
    });
    repositoryMocks.transaction.discordReservationMessage.findUnique.mockResolvedValue({
      channelId: "channel-1",
      initialSendStatus: "PENDING_REVIEW",
      nonce: "nonce-1",
      postOperationBoundary: "post-boundary-1",
      postOperationEpoch: 7,
      remoteVerificationCursor: null,
      reservation: { userId: "user-1" },
      reservationId: "reservation-1"
    });
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 0 });
    const repository = createPrismaDiscordRemoteVerificationRepository({
      actor,
      adminId: "admin-1",
      ipHash: "ip-hash",
      now: repositoryNow
    });
    await repository.loadTarget({ expectedControlEpoch: 7, expectedState: "PENDING_REVIEW", reservationId: "reservation-1" });

    // When: saving a completed scan loses the compare-and-set race.
    const saved = await repository.saveProgress({
      boundMessageId: null,
      continuation: {
        attemptBoundary: "post-boundary-1",
        before: null,
        complete: true,
        lastErrorCode: null,
        matchedMessageIds: [],
        pagesScanned: 1,
        status: "ZERO_COMPLETE",
        version: 1
      },
      expectedControlEpoch: 7,
      reservationId: "reservation-1"
    });

    // Then: no success audit pair is emitted.
    expect(saved).toBe(false);
    expect(repositoryMocks.transaction.adminAction.create).not.toHaveBeenCalled();
    expect(repositoryMocks.transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    ["retry", "FAILED", undefined, "CONFIRMED"],
    ["sync", "RETRY:2:1:7", undefined, "CONFIRMED"],
    ["remove_controls", "RETRY:2:1:7", "reservation-1", "CANCELLED"],
    ["abandon", "PENDING_REVIEW", "reservation-1", "CONFIRMED"]
  ] as const)("applies eligible %s once and writes exactly one action/audit pair", async (
    action,
    expectedState,
    confirmation,
    reservationStatus
  ) => {
    // Given: the current row and control epoch permit exactly one matrix action.
    repositoryMocks.transaction.discordOperationsControl.findUnique.mockResolvedValue({
      enabled: true,
      epoch: 7,
      pendingRemoteCleanup: false
    });
    repositoryMocks.transaction.discordReservationMessage.findUnique.mockResolvedValue(
      repairableRow({
        initialSendStatus: action === "retry" ? "FAILED" : action === "abandon" ? "PENDING_REVIEW" : "SENT",
        remoteVerificationStatus: action === "abandon" ? "ZERO_COMPLETE" : null,
        reservationStatus
      })
    );
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });
    repositoryMocks.transaction.adminAction.create.mockResolvedValue({ id: "action-1" });

    // When: the administrator performs the eligible repair.
    const result = await repairDiscordReservationMessageWithPrisma({
      action,
      actor,
      adminId: "admin-1",
      ...(confirmation === undefined ? {} : { confirmation }),
      expectedControlEpoch: 7,
      expectedState,
      ipHash: "ip-hash",
      now: repositoryNow,
      reservationId: "reservation-1"
    });

    // Then: one conditional mutation and exactly one audit pair record the action.
    expect(result).toEqual({ auditActionId: "action-1", kind: "repaired" });
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.transaction.adminAction.create).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.transaction.auditLog.create).toHaveBeenCalledTimes(1);
    if (action === "abandon") {
      const write = repositoryMocks.transaction.discordReservationMessage.updateMany.mock.calls[0]?.[0];
      expect(write?.data).not.toHaveProperty("nonce");
      expect(write?.data).not.toHaveProperty("remoteVerificationCursor");
    }
  });

  it("abandons an unresolved ambiguous send once while preserving its nonce tombstone", async () => {
    // Given: a completed zero-match review leaves an ambiguous POST pending review.
    repositoryMocks.transaction.discordReservationMessage.findUnique
      .mockResolvedValueOnce(repairableRow({ initialSendStatus: "PENDING_REVIEW", remoteVerificationStatus: "ZERO_COMPLETE" }))
      .mockResolvedValueOnce(repairableRow({ initialSendStatus: "ABANDONED", remoteVerificationStatus: "ZERO_COMPLETE" }));
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });
    repositoryMocks.transaction.adminAction.create.mockResolvedValue({ id: "action-1" });
    const request = {
      action: "abandon" as const,
      actor,
      adminId: "admin-1",
      confirmation: "reservation-1",
      expectedControlEpoch: 7,
      expectedState: "PENDING_REVIEW",
      ipHash: "ip-hash",
      now: repositoryNow,
      reservationId: "reservation-1"
    };

    // When: the operator abandons it and then repeats the same action.
    const first = await repairDiscordReservationMessageWithPrisma(request);
    const second = await repairDiscordReservationMessageWithPrisma(request);

    // Then: only the first transition succeeds and records its audit pair.
    expect(first).toEqual({ auditActionId: "action-1", kind: "repaired" });
    expect(second).toEqual({ code: "stale_state", kind: "conflict" });
    const write = repositoryMocks.transaction.discordReservationMessage.updateMany.mock.calls[0]?.[0];
    expect(write?.data).toMatchObject({ initialSendStatus: "ABANDONED", syncStatus: "ABANDONED" });
    expect(write?.data).not.toHaveProperty("nonce");
    expect(write?.data).not.toHaveProperty("remoteVerificationCursor");
    expect(repositoryMocks.transaction.adminAction.create).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.transaction.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["retry", "PENDING_REVIEW", undefined, repairableRow({ initialSendStatus: "PENDING_REVIEW" })],
    ["retry", "FAILED", undefined, repairableRow({ initialSendAttempts: 8 })],
    ["retry", "FAILED", undefined, repairableRow({ initialSendOutcome: "UNKNOWN" })],
    ["sync", "RETRY:2:1:7", undefined, repairableRow({ messageId: null })],
    ["sync", "SYNCED:1:1:7", undefined, repairableRow({ messageRevision: 1, syncedRevision: 1 })],
    ["sync", "RETRY:2:1:7", undefined, repairableRow({ renderedSourceEpoch: 8 })],
    ["remove_controls", "RETRY:2:1:7", "wrong-reservation", repairableRow({ reservationStatus: "CANCELLED" })],
    ["remove_controls", "RETRY:2:1:7", "reservation-1", repairableRow({ reservationStatus: "CONFIRMED" })],
    ["abandon", "PENDING_REVIEW", "reservation-1", repairableRow({ initialSendStatus: "PENDING_REVIEW", remoteVerificationStatus: "PENDING" })]
  ] as const)("rejects forbidden %s repair state without mutation or audit", async (action, expectedState, confirmation, row) => {
    // Given: the target is present but violates one repair-matrix precondition.
    repositoryMocks.transaction.discordReservationMessage.findUnique.mockResolvedValue(row);

    // When: the administrator attempts the named action.
    const result = await repairDiscordReservationMessageWithPrisma({
      action,
      actor,
      adminId: "admin-1",
      ...(confirmation === undefined ? {} : { confirmation }),
      expectedControlEpoch: 7,
      expectedState,
      ipHash: "ip-hash",
      now: repositoryNow,
      reservationId: "reservation-1"
    });

    // Then: no state or audit record changes.
    expect(result).toEqual({ code: "stale_state", kind: "conflict" });
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).not.toHaveBeenCalled();
    expect(repositoryMocks.transaction.adminAction.create).not.toHaveBeenCalled();
    expect(repositoryMocks.transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it("reports a missing repair target without mutation or audit", async () => {
    // Given: the requested reservation has no Discord message record.
    repositoryMocks.transaction.discordReservationMessage.findUnique.mockResolvedValue(null);

    // When: the administrator requests a retry.
    const result = await repairDiscordReservationMessageWithPrisma({
      action: "retry",
      actor,
      adminId: "admin-1",
      expectedControlEpoch: 7,
      expectedState: "FAILED",
      ipHash: "ip-hash",
      now: repositoryNow,
      reservationId: "missing-reservation"
    });

    // Then: the route layer can truthfully return not found without recording a false repair.
    expect(result).toEqual({ kind: "not_found" });
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).not.toHaveBeenCalled();
    expect(repositoryMocks.transaction.adminAction.create).not.toHaveBeenCalled();
    expect(repositoryMocks.transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects retry for an ambiguous pending-review row even after a complete zero scan", async () => {
    // Given: the original POST is ambiguous and remote verification completed with zero matches.
    repositoryMocks.transaction.discordOperationsControl.findUnique.mockResolvedValue({
      enabled: true,
      epoch: 7,
      pendingRemoteCleanup: false
    });
    repositoryMocks.transaction.discordReservationMessage.findUnique.mockResolvedValue(
      repairableRow({ initialSendStatus: "PENDING_REVIEW", remoteVerificationStatus: "ZERO_COMPLETE" })
    );

    // When: an operator attempts to retry the original POST.
    const result = await repairDiscordReservationMessageWithPrisma({
      action: "retry",
      actor,
      adminId: "admin-1",
      expectedControlEpoch: 7,
      expectedState: "PENDING_REVIEW",
      ipHash: "ip-hash",
      now: repositoryNow,
      reservationId: "reservation-1"
    });

    // Then: no second POST can be made claimable and no audit falsely records success.
    expect(result).toEqual({ code: "stale_state", kind: "conflict" });
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).not.toHaveBeenCalled();
    expect(repositoryMocks.transaction.adminAction.create).not.toHaveBeenCalled();
  });

  it("rejects a stale control epoch before attempting a sync mutation", async () => {
    repositoryMocks.transaction.$queryRaw.mockResolvedValue([{
      enabled: true,
      epoch: 8,
      pendingRemoteCleanup: false
    }]);
    repositoryMocks.transaction.discordReservationMessage.findUnique.mockResolvedValue(repairableRow({}));

    const result = await repairDiscordReservationMessageWithPrisma({
      action: "sync",
      actor,
      adminId: "admin-1",
      expectedControlEpoch: 7,
      expectedState: "RETRY:2:1:7",
      ipHash: "ip-hash",
      now: repositoryNow,
      reservationId: "reservation-1"
    });

    expect(result).toEqual({ code: "stale_epoch", kind: "conflict" });
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    [{ enabled: false, epoch: 8, pendingRemoteCleanup: true }, "disabled"],
    [{ enabled: true, epoch: 8, pendingRemoteCleanup: true }, "draining"]
  ] as const)("applies operation-fence precedence before stale epoch as %s", async (control, code) => {
    repositoryMocks.transaction.$queryRaw.mockResolvedValue([control]);
    repositoryMocks.transaction.discordReservationMessage.findUnique.mockResolvedValue(repairableRow({}));

    const result = await repairDiscordReservationMessageWithPrisma({
      action: "sync",
      actor,
      adminId: "admin-1",
      expectedControlEpoch: 7,
      expectedState: "RETRY:2:1:7",
      ipHash: "ip-hash",
      now: repositoryNow,
      reservationId: "reservation-1"
    });

    expect(result).toEqual({ code, kind: "conflict" });
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).not.toHaveBeenCalled();
  });

  it("returns conflict without audit when a concurrent repair wins the row CAS", async () => {
    repositoryMocks.transaction.discordOperationsControl.findUnique.mockResolvedValue({
      enabled: true,
      epoch: 7,
      pendingRemoteCleanup: false
    });
    repositoryMocks.transaction.discordReservationMessage.findUnique.mockResolvedValue(repairableRow({}));
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 0 });

    const result = await repairDiscordReservationMessageWithPrisma({
      action: "sync",
      actor,
      adminId: "admin-1",
      expectedControlEpoch: 7,
      expectedState: "RETRY:2:1:7",
      ipHash: "ip-hash",
      now: repositoryNow,
      reservationId: "reservation-1"
    });

    expect(result).toEqual({ code: "stale_state", kind: "conflict" });
    expect(repositoryMocks.transaction.adminAction.create).not.toHaveBeenCalled();
    expect(repositoryMocks.transaction.auditLog.create).not.toHaveBeenCalled();
  });
});

function repairableRow(input: {
  readonly initialSendAttempts?: number;
  readonly initialSendOutcome?: string | null;
  readonly initialSendStatus?: string;
  readonly messageId?: string | null;
  readonly messageRevision?: number;
  readonly remoteVerificationStatus?: string | null;
  readonly renderedSourceEpoch?: number;
  readonly reservationStatus?: string;
  readonly syncedRevision?: number;
}) {
  return {
    initialSendAttempts: input.initialSendAttempts ?? 1,
    initialSendOutcome: input.initialSendOutcome ?? "FAILED",
    initialSendStatus: input.initialSendStatus ?? "SENT",
    legacyControlState: "CURRENT",
    messageId: "messageId" in input ? input.messageId : "message-1",
    messageRevision: input.messageRevision ?? 2,
    postOperationEpoch: 7,
    remoteVerificationStatus: input.remoteVerificationStatus ?? null,
    renderedSourceEpoch: input.renderedSourceEpoch ?? 7,
    reservation: { status: input.reservationStatus ?? "CONFIRMED", userId: "user-1" },
    reservationId: "reservation-1",
    syncStatus: "RETRY",
    syncedRevision: input.syncedRevision ?? 1
  };
}
