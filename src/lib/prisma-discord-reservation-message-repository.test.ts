import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Model = {
  readonly create: ReturnType<typeof vi.fn>;
  readonly deleteMany: ReturnType<typeof vi.fn>;
  readonly findMany: ReturnType<typeof vi.fn>;
  readonly findUnique: ReturnType<typeof vi.fn>;
  readonly updateMany: ReturnType<typeof vi.fn>;
};

type ReceiptRow = { readonly terminalResult: Prisma.JsonValue };
type ReceiptModel = {
  readonly createMany: ReturnType<typeof vi.fn<(input: Prisma.DiscordInteractionReceiptCreateManyArgs) => Promise<Prisma.BatchPayload>>>;
  readonly deleteMany: ReturnType<typeof vi.fn>;
  readonly findMany: ReturnType<typeof vi.fn>;
  readonly findUnique: ReturnType<typeof vi.fn<(input: Prisma.DiscordInteractionReceiptFindUniqueArgs) => Promise<ReceiptRow | null>>>;
  readonly updateMany: ReturnType<typeof vi.fn>;
};

const repositoryMocks = vi.hoisted(() => {
  const model = (): Model => ({
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
    findUnique: vi.fn(),
    updateMany: vi.fn()
  });
  const transaction = {
    discordInteractionReceipt: receiptModel(),
    discordReservationMessage: model()
  };
  return {
    transaction,
    withDatabaseContext: vi.fn(async (input: { readonly operation: (value: typeof transaction) => Promise<unknown> }) =>
      input.operation(transaction)
    )
  };
});

vi.mock("./db", () => ({ prisma: { kind: "prisma" } }));
vi.mock("./db-context", () => ({
  systemDatabaseActor: () => ({ id: null, role: "SYSTEM" }),
  withDatabaseContext: repositoryMocks.withDatabaseContext
}));

import {
  DISCORD_CLAIM_BATCH_SIZE,
  DISCORD_CLAIM_LEASE_MS,
  DISCORD_CLEANUP_BATCH_SIZE,
  cappedDiscordRetryAt,
  prismaDiscordReservationMessageRepository,
  recordDiscordInteractionReceipt
} from "./prisma-discord-reservation-message-repository";

const now = new Date("2026-08-11T00:00:00.000Z");

describe("Prisma Discord reservation message repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repositoryMocks.transaction.discordReservationMessage.findMany.mockResolvedValue([]);
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 0 });
    repositoryMocks.transaction.discordReservationMessage.deleteMany.mockResolvedValue({ count: 0 });
    repositoryMocks.transaction.discordInteractionReceipt.findMany.mockResolvedValue([]);
    repositoryMocks.transaction.discordInteractionReceipt.deleteMany.mockResolvedValue({ count: 0 });
  });

  it("claims at most 20 due initial sends with an exact 120-second stale lease", async () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      initialSendAttempts: index,
      nonce: `nonce-${index}`,
      reservationId: `reservation-${index}`
    }));
    repositoryMocks.transaction.discordReservationMessage.findMany.mockResolvedValue(rows);
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });

    const claims = await prismaDiscordReservationMessageRepository.claimInitialSends(now);

    expect(DISCORD_CLAIM_BATCH_SIZE).toBe(20);
    expect(DISCORD_CLAIM_LEASE_MS).toBe(120_000);
    expect(repositoryMocks.transaction.discordReservationMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 20,
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              initialSendClaimedAt: { lte: new Date("2026-08-10T23:58:00.000Z") },
              initialSendStatus: "SENDING"
            })
          ])
        })
      })
    );
    expect(claims).toHaveLength(20);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledTimes(20);
  });

  it("rejects an initial-send save after its claim has been replaced", async () => {
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 0 });

    const saved = await prismaDiscordReservationMessageRepository.saveInitialSendSuccess({
      channelId: "channel",
      claimId: "stale-claim",
      guildId: "guild",
      messageId: "message",
      reservationId: "reservation",
      sentAt: now
    });

    expect(saved).toBe(false);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ initialSendClaimId: "stale-claim", initialSendStatus: "SENDING" }) })
    );
  });

  it("queues a sync when the reservation revision changes during the initial send", async () => {
    repositoryMocks.transaction.discordReservationMessage.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    const saved = await prismaDiscordReservationMessageRepository.saveInitialSendSuccess({
      channelId: "channel", claimId: "claim", guildId: "guild", messageId: "message",
      reservationId: "reservation", sentAt: now
    });

    expect(saved).toBe(true);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ syncNextAttemptAt: now, syncStatus: "PENDING" }),
        where: expect.objectContaining({ initialSendClaimId: "claim", messageRevision: { gt: 0 } })
      })
    );
  });

  it("claims at most 20 due message revisions with the same lease", async () => {
    repositoryMocks.transaction.discordReservationMessage.findMany.mockResolvedValue(Array.from({ length: 25 }, (_, index) => ({
      channelId: "channel", guildId: "guild", messageId: `message-${index}`, messageRevision: 2,
      reservationId: `reservation-${index}`, syncAttempts: 0, syncedRevision: 1
    })));
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });

    const claims = await prismaDiscordReservationMessageRepository.claimMessageSyncs(now);

    expect(claims).toHaveLength(20);
    expect(repositoryMocks.transaction.discordReservationMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20, where: expect.objectContaining({ OR: expect.arrayContaining([
        expect.objectContaining({ syncClaimedAt: { lte: new Date("2026-08-10T23:58:00.000Z") }, syncStatus: "SYNCING" })
      ]) }) })
    );
  });

  it("rejects a sync save when a newer message revision superseded the claim", async () => {
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 0 });

    const saved = await prismaDiscordReservationMessageRepository.saveSyncSuccess({
      claimId: "sync-claim",
      reservationId: "reservation",
      revision: 3,
      syncedAt: now
    });

    expect(saved).toBe(false);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ syncedRevision: 3 }),
        where: expect.objectContaining({ messageRevision: 3, syncClaimId: "sync-claim", syncClaimRevision: 3 })
      })
    );
  });

  it("bumps the revision and invalidates an active sync claim", async () => {
    repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 1 });

    const bumped = await prismaDiscordReservationMessageRepository.bumpMessageRevision("reservation", now);

    expect(bumped).toBe(true);
    expect(repositoryMocks.transaction.discordReservationMessage.updateMany).toHaveBeenCalledWith({
      data: {
        messageRevision: { increment: 1 },
        syncClaimId: null,
        syncClaimRevision: null,
        syncClaimedAt: null,
        syncError: null,
        syncNextAttemptAt: now,
        syncStatus: "PENDING"
      },
      where: { reservationId: "reservation" }
    });
  });

  it("replays the stored terminal receipt after an interaction-id conflict", async () => {
    const result = { kind: "accepted", reservationId: "reservation" };
    repositoryMocks.transaction.discordInteractionReceipt.createMany.mockResolvedValue({ count: 0 });
    repositoryMocks.transaction.discordInteractionReceipt.findUnique.mockResolvedValue({ terminalResult: result });

    const receipt = await recordDiscordInteractionReceipt(repositoryMocks.transaction, {
      discordActorId: "discord-user",
      interactionId: "interaction",
      intent: "ACCEPT",
      localActorId: "admin",
      messageId: "message",
      reservationId: "reservation",
      status: "TERMINAL",
      terminalOutcome: "ACCEPTED",
      terminalResult: result
    });

    expect(receipt).toEqual({ kind: "replayed", terminalResult: result });
  });

  it("caps retry scheduling at 60 minutes", () => {
    expect(cappedDiscordRetryAt(now, 1)).toEqual(new Date("2026-08-11T00:01:00.000Z"));
    expect(cappedDiscordRetryAt(now, 20)).toEqual(new Date("2026-08-11T01:00:00.000Z"));
  });

  it("deletes only bounded expired terminal message rows", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({ reservationId: `reservation-${index}` }));
    repositoryMocks.transaction.discordReservationMessage.findMany.mockResolvedValue(rows);
    repositoryMocks.transaction.discordReservationMessage.deleteMany.mockResolvedValue({ count: 100 });

    const result = await prismaDiscordReservationMessageRepository.deleteExpiredMessages(now);

    expect(DISCORD_CLEANUP_BATCH_SIZE).toBe(100);
    expect(result).toEqual({ hasMore: true, processedCount: 100, remainingLowerBound: 1 });
    expect(repositoryMocks.transaction.discordReservationMessage.deleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lte: now },
        initialSendStatus: { in: ["SENT", "ABANDONED"] },
        reservationId: { in: rows.slice(0, 100).map((row) => row.reservationId) },
        syncStatus: { in: ["SYNCED", "ABANDONED"] }
      }
    });
  });
});
