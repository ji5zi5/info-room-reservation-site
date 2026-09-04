import { beforeEach, describe, expect, it, vi } from "vitest";

const now = new Date("2026-09-04T10:20:00.000Z");
const activeBoard = {
  channelId: null,
  claimedAt: new Date("2026-09-04T10:19:30.000Z"),
  claimId: "active-claim",
  guildId: null,
  id: "discord-operations-board",
  messageId: null,
  nextAttemptAt: null,
  renderedDate: null,
  revision: 0,
  stateDigest: null,
  syncAttempts: 1,
  syncStatus: "SYNCING",
  updatedAt: new Date("2026-09-04T10:19:30.000Z")
};

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  upsert: vi.fn(),
  withDatabaseContext: vi.fn()
}));

vi.mock("./db", () => ({ prisma: { id: "prisma" } }));
vi.mock("./db-context", () => ({
  systemDatabaseActor: () => ({ id: null, role: "SYSTEM" }),
  withDatabaseContext: mocks.withDatabaseContext
}));

import {
  claimDiscordOperationsBoardSync,
  requestDiscordOperationsBoardSync
} from "./prisma-discord-operations-board";

describe("Prisma Discord operations board", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const transaction = {
      discordOperationsBoard: {
        findUnique: mocks.findUnique,
        update: mocks.update,
        updateMany: mocks.updateMany,
        upsert: mocks.upsert
      }
    };
    mocks.withDatabaseContext.mockImplementation(async ({ operation }) => operation(transaction));
    mocks.findUnique.mockResolvedValue(activeBoard);
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.upsert.mockResolvedValue(activeBoard);
  });

  it("does not invalidate a live claim for a forced refresh", async () => {
    // Given: another worker owns an unexpired synchronization claim.

    // When: a manual refresh tries to force a new claim.
    const result = await claimDiscordOperationsBoardSync({ force: true, now });

    // Then: the live worker remains fenced and no competing Discord message can be created.
    expect(result).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { nextAttemptAt: now, syncStatus: "PENDING" },
      where: refreshableWhere()
    }));
  });

  it("does not replace a live claim when a mutation requests refresh", async () => {
    // Given: board synchronization is already active.

    // When: a web or Discord mutation requests another refresh.
    await requestDiscordOperationsBoardSync(now);

    // Then: singleton initialization is harmless and only non-live claims can be moved to pending.
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { nextAttemptAt: now, syncStatus: "PENDING" },
      where: refreshableWhere()
    }));
  });
});

function refreshableWhere() {
  return {
    id: "discord-operations-board",
    OR: [
      { syncStatus: { not: "SYNCING" } },
      { claimedAt: null },
      { claimedAt: { lte: new Date("2026-09-04T10:18:00.000Z") } }
    ]
  };
}
