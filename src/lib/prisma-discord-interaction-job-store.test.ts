import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: {
    $queryRaw: vi.fn(),
    discordInteractionJob: {
      aggregate: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn()
    },
    discordOperationsControl: { findUnique: vi.fn() }
  },
  withContext: vi.fn()
}));

vi.mock("./prisma-discord-reservation-message-context", () => ({
  withDiscordReservationMessageSystemContext: mocks.withContext
}));

import {
  DISCORD_INTERACTION_CLAIM_BATCH_SIZE,
  DISCORD_INTERACTION_CLAIM_LEASE_MS,
  enqueueDiscordInteractionJob,
  getDiscordInteractionBacklogSummary,
  prismaDiscordInteractionJobStore
} from "./prisma-discord-interaction-job-store";

const now = new Date("2026-08-13T00:00:00.000Z");
const command = {
  commandDigest: "sha256:command-a",
  discordActorId: "discord-admin",
  handshakeStatus: "ACKNOWLEDGED" as const,
  interactionId: "interaction-1",
  intent: "accept",
  ipHash: "sha256:ip",
  localActorId: "admin-1",
  renderedEpoch: 7,
  reservationId: "reservation-1",
  sourceApplicationId: "application-1",
  sourceChannelId: "channel-1",
  sourceGuildId: "guild-1",
  sourceMessageId: "message-1"
};

describe("Prisma Discord interaction job store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withContext.mockImplementation(async (operation) => operation(mocks.transaction));
    mocks.transaction.$queryRaw.mockResolvedValue([{ enabled: true, epoch: 7 }]);
    mocks.transaction.discordOperationsControl.findUnique.mockResolvedValue({ enabled: true, epoch: 7 });
    mocks.transaction.discordInteractionJob.findMany.mockResolvedValue([]);
    mocks.transaction.discordInteractionJob.updateMany.mockResolvedValue({ count: 0 });
  });

  it("enqueues once and replays an identical interaction digest", async () => {
    // Given: the first insert wins and the durable row has the same digest.
    mocks.transaction.discordInteractionJob.createMany.mockResolvedValue({ count: 1 });
    mocks.transaction.discordInteractionJob.findUnique.mockResolvedValue({ commandDigest: command.commandDigest });

    // When: the same signed command is delivered twice.
    const first = await enqueueDiscordInteractionJob(command);
    mocks.transaction.discordInteractionJob.createMany.mockResolvedValue({ count: 0 });
    const duplicate = await enqueueDiscordInteractionJob(command);

    // Then: the caller observes one enqueue and one idempotent replay.
    expect(first).toEqual({ kind: "enqueued" });
    expect(duplicate).toEqual({ kind: "duplicate" });
  });

  it("returns a terminal security conflict without mutating the existing job", async () => {
    // Given: an interaction ID already belongs to a different immutable command digest.
    mocks.transaction.discordInteractionJob.createMany.mockResolvedValue({ count: 0 });
    mocks.transaction.discordInteractionJob.findUnique.mockResolvedValue({ commandDigest: "sha256:original" });

    // When: an attacker reuses the ID with different command bytes.
    const result = await enqueueDiscordInteractionJob(command);

    // Then: conflict is terminal and no update path runs.
    expect(result).toEqual({ kind: "security_conflict" });
    expect(mocks.transaction.discordInteractionJob.updateMany).not.toHaveBeenCalled();
  });

  it("allows one claimant and recovers only after the 120-second lease", async () => {
    // Given: competing workers observe the same pending row and CAS updates mutate shared state.
    let status = "PENDING";
    mocks.transaction.discordInteractionJob.findMany.mockImplementation(async () => [{
      attempts: status === "PENDING" ? 0 : 1,
      interactionId: "interaction-1",
      renderedEpoch: 7
    }]);
    mocks.transaction.discordInteractionJob.updateMany.mockImplementation(async ({ data, where }: {
      readonly data: { readonly status: string };
      readonly where: { readonly OR: readonly {
        readonly claimedAt?: { readonly lte: Date };
        readonly status?: string | { readonly in?: readonly string[] };
      }[] };
    }) => {
      const expected = where.OR.some((candidate) => {
        if (typeof candidate.status !== "string" && candidate.status?.in?.includes(status)) return true;
        return candidate.status === status &&
          candidate.claimedAt !== undefined &&
          candidate.claimedAt.lte.getTime() >= now.getTime();
      });
      if (!expected) return { count: 0 };
      status = data.status;
      return { count: 1 };
    });

    // When: two workers claim concurrently, then a worker retries at each lease boundary.
    const [left, right] = await Promise.all([
      prismaDiscordInteractionJobStore.claim(now),
      prismaDiscordInteractionJobStore.claim(now)
    ]);
    mocks.transaction.discordInteractionJob.findMany.mockResolvedValue([{ attempts: 1, interactionId: "interaction-1", renderedEpoch: 7 }]);
    const beforeLease = await prismaDiscordInteractionJobStore.claim(new Date(now.getTime() + 119_999));
    status = "PROCESSING";
    const atLease = await prismaDiscordInteractionJobStore.claim(new Date(now.getTime() + 120_000));

    // Then: exactly one initial claimant exists and stale work is recoverable exactly at 120 seconds.
    expect([...left, ...right]).toHaveLength(1);
    expect(beforeLease).toHaveLength(0);
    expect(atLease).toHaveLength(1);
    expect(DISCORD_INTERACTION_CLAIM_LEASE_MS).toBe(120_000);
    expect(DISCORD_INTERACTION_CLAIM_BATCH_SIZE).toBe(20);
  });

  it("does not claim while control is disabled", async () => {
    // Given: operations control is disabled.
    mocks.transaction.$queryRaw.mockResolvedValue([{ enabled: false, epoch: 7 }]);

    // When: a worker asks for work.
    const result = await prismaDiscordInteractionJobStore.claim(now);

    // Then: no claim is returned and jobs are untouched.
    expect(result).toEqual([]);
    expect(mocks.transaction.discordInteractionJob.updateMany).not.toHaveBeenCalled();
  });

  it("bounds backlog claims at twenty but fast-claims one exact interaction", async () => {
    // Given: the adapter sees more eligible rows than one worker may own.
    const rows = Array.from({ length: 21 }, (_, index) => ({
      ...command,
      attempts: 0,
      interactionId: `interaction-${index}`
    }));
    mocks.transaction.discordInteractionJob.findMany.mockImplementation(async (input: {
      readonly take: number;
      readonly where: { readonly interactionId?: string };
    }) => rows.filter((row) =>
      input.where.interactionId === undefined || row.interactionId === input.where.interactionId
    ).slice(0, input.take));
    mocks.transaction.discordInteractionJob.updateMany.mockResolvedValue({ count: 1 });

    // When: a backlog claim and an exact interaction claim run.
    const batch = await prismaDiscordInteractionJobStore.claim(now);
    const exact = await prismaDiscordInteractionJobStore.claim(now, "interaction-9");

    // Then: the returned work is bounded and exact claiming asks Prisma for one named row.
    expect(batch).toHaveLength(20);
    expect(exact).toHaveLength(1);
    expect(exact[0]?.interactionId).toBe("interaction-9");
    expect(exact[0]?.sourceApplicationId).toBe("application-1");
    expect(mocks.transaction.discordInteractionJob.findMany.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ take: 1, where: expect.objectContaining({ interactionId: "interaction-9" }) })
    );
  });

  it("rejects dispatch after the enabled control epoch changes", async () => {
    // Given: the claimed job still has its immutable epoch and claim token.
    const currentClaim = {
      ...command,
      attempts: 1,
      claimId: "claim-1"
    };
    mocks.transaction.discordInteractionJob.findUnique.mockResolvedValue({
      claimId: "claim-1",
      renderedEpoch: 7,
      status: "PROCESSING"
    });

    // When: dispatch is checked before and after an acknowledged re-enable to epoch eight.
    const current = await prismaDiscordInteractionJobStore.isDispatchAllowed(currentClaim);
    mocks.transaction.discordOperationsControl.findUnique.mockResolvedValue({ enabled: true, epoch: 8 });
    const stale = await prismaDiscordInteractionJobStore.isDispatchAllowed(currentClaim);

    // Then: only the current enabled epoch can dispatch.
    expect(current).toBe(true);
    expect(stale).toBe(false);
  });

  it("persists an unbound legacy claim as stale application-binding review", async () => {
    mocks.transaction.discordInteractionJob.updateMany.mockResolvedValue({ count: 1 });
    const claim = {
      ...command,
      attempts: 1,
      claimId: "claim-unbound",
      sourceApplicationId: null
    };

    await prismaDiscordInteractionJobStore.completeStale({
      claim,
      errorCode: "discord_source_application_missing",
      terminalResult: { code: "discord_source_application_missing" }
    });

    expect(mocks.transaction.discordInteractionJob.updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        errorCode: "discord_source_application_missing",
        lastError: "APPLICATION_BINDING_REVIEW",
        nextAttemptAt: null,
        status: "STALE"
      }),
      where: {
        claimId: "claim-unbound",
        interactionId: command.interactionId,
        status: "PROCESSING"
      }
    });
  });

  it("summarizes counts and the oldest backlog age", async () => {
    // Given: three actionable jobs with a ten-minute-old oldest row.
    mocks.transaction.discordInteractionJob.aggregate.mockResolvedValue({ _count: { _all: 3 }, _min: { createdAt: new Date(now.getTime() - 600_000) } });

    // When: operations reads backlog health.
    const result = await getDiscordInteractionBacklogSummary(now);

    // Then: the summary exposes count, oldest timestamp, and age.
    expect(result).toEqual({ count: 3, oldestAgeMs: 600_000, oldestCreatedAt: new Date(now.getTime() - 600_000) });
  });

  it("persists only redacted command context and error fields", async () => {
    // Given: a valid enqueue with hash-only source context.
    mocks.transaction.discordInteractionJob.createMany.mockResolvedValue({ count: 1 });
    mocks.transaction.discordInteractionJob.findUnique.mockResolvedValue({ commandDigest: command.commandDigest });

    // When: the command is persisted.
    await enqueueDiscordInteractionJob(command);

    // Then: serialized durable input has no token, raw body, raw IP, or request-role snapshot field.
    const persisted = mocks.transaction.discordInteractionJob.createMany.mock.calls[0]?.[0]?.data;
    expect(persisted.sourceApplicationId).toBe("application-1");
    expect(Object.keys(persisted)).toEqual(expect.arrayContaining(Object.keys(command)));
    expect(Object.keys(persisted)).not.toEqual(expect.arrayContaining(["token", "rawBody", "rawIp", "requestRoleIds"]));
  });
});
