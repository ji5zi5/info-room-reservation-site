import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PeriodSummary } from "./period-settings";

type DeliveryRow = {
  readonly sentAt: Date | null;
  readonly status: string;
  readonly studyPeriod: string;
  readonly updatedAt: Date;
};

type DeliveryFindManyInput = {
  readonly select: unknown;
  readonly where: { readonly date: string; readonly kind: string };
};

type SnapshotTransaction = {
  readonly adminAction: { readonly findFirst: (input: unknown) => Promise<{ readonly createdAt: Date } | null> };
  readonly discordAdminCommandJob: {
    readonly count: (input: unknown) => Promise<number>;
    readonly findFirst: (input: unknown) => Promise<{ readonly updatedAt: Date } | null>;
  };
  readonly discordInteractionJob: {
    readonly count: (input: unknown) => Promise<number>;
    readonly findFirst: (input: unknown) => Promise<{ readonly updatedAt: Date } | null>;
  };
  readonly notificationDelivery: {
    readonly count: (input: unknown) => Promise<number>;
    readonly findFirst: (input: unknown) => Promise<{ readonly updatedAt: Date } | null>;
    readonly findMany: (input: DeliveryFindManyInput) => Promise<readonly DeliveryRow[]>;
  };
  readonly operationalJob: {
    readonly count: (input: unknown) => Promise<number>;
    readonly findMany: (input: unknown) => Promise<readonly []>;
  };
};

type DatabaseContextInput = {
  readonly actor: { readonly id: string | null; readonly role: "SYSTEM" };
  readonly client: unknown;
  readonly operation: (transaction: SnapshotTransaction) => Promise<unknown>;
};

const mocks = vi.hoisted(() => {
  const deliveryFindMany = vi.fn<(input: DeliveryFindManyInput) => Promise<readonly DeliveryRow[]>>();
  const notificationDeliveryCount = vi.fn<(input: unknown) => Promise<number>>();
  const count = vi.fn<(input: unknown) => Promise<number>>();
  const findFirst = vi.fn<(input: unknown) => Promise<null>>();
  const transaction = {
    adminAction: { findFirst },
    discordAdminCommandJob: { count, findFirst },
    discordInteractionJob: { count, findFirst },
    notificationDelivery: { count: notificationDeliveryCount, findFirst, findMany: deliveryFindMany },
    operationalJob: { count, findMany: vi.fn().mockResolvedValue([]) }
  } satisfies SnapshotTransaction;
  return {
    count,
    deliveryFindMany,
    findFirst,
    getNotificationSettings: vi.fn(),
    getPeriodSummaries: vi.fn(),
    notificationDeliveryCount,
    transaction,
    withDatabaseContext: vi.fn<(input: DatabaseContextInput) => Promise<unknown>>()
  };
});

vi.mock("./db", () => ({ prisma: { id: "prisma-client" } }));
vi.mock("./db-context", () => ({
  systemDatabaseActor: () => ({ id: null, role: "SYSTEM" }),
  withDatabaseContext: mocks.withDatabaseContext
}));
vi.mock("./period-settings", () => ({ getPeriodSummaries: mocks.getPeriodSummaries }));
vi.mock("./prisma-notification-settings", () => ({
  getPrismaNotificationSettings: mocks.getNotificationSettings
}));

import { loadDiscordOperationsBoardSnapshot } from "./discord-operations-board-snapshot";

describe("Discord operations board snapshot", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.count.mockResolvedValue(0);
    mocks.findFirst.mockResolvedValue(null);
    mocks.notificationDeliveryCount.mockResolvedValue(1);
    mocks.getNotificationSettings.mockResolvedValue({
      closedPeriodNotificationsEnabled: true,
      reservationCreatedNotificationsEnabled: false
    });
    mocks.getPeriodSummaries.mockResolvedValue([period("EIGHTH", "8면학"), period("FIRST", "1면학")]);
    mocks.deliveryFindMany.mockImplementation(async ({ where }) => where.kind === "CLOSED_LIST"
      ? [{
          sentAt: new Date("2026-09-04T07:21:00.000Z"),
          status: "SENT",
          studyPeriod: "EIGHTH",
          updatedAt: new Date("2026-09-04T07:21:00.000Z")
        }]
      : []);
    mocks.withDatabaseContext.mockImplementation(async ({ operation }) => operation(mocks.transaction));
  });

  it("loads the real closed-list delivery kind and counts only operator-actionable deliveries", async () => {
    // Given: a sent closed-list delivery stored under the production kind.

    // When: the board snapshot is loaded.
    const result = await loadDiscordOperationsBoardSnapshot({
      date: "2026-09-04",
      now: new Date("2026-09-04T08:30:00.000Z")
    });

    // Then: the sent state is visible and routine in-flight rows are excluded from operator attention.
    expect(result.periods[0]).toMatchObject({
      closedListProcessedAt: "2026-09-04T07:21:00.000Z",
      closedListStatus: "SENT"
    });
    expect(mocks.deliveryFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { date: "2026-09-04", kind: "CLOSED_LIST" }
    }));
    expect(mocks.notificationDeliveryCount).toHaveBeenCalledWith({
      where: {
        kind: "CLOSED_LIST",
        status: { in: ["FAILED", "PENDING_REVIEW", "UNKNOWN"] }
      }
    });
  });
});

function period(studyPeriod: "EIGHTH" | "FIRST", label: string): PeriodSummary {
  return {
    applicants: [],
    capacity: 10,
    closeTime: "16:20",
    confirmedCount: 0,
    date: "2026-09-04",
    enabled: true,
    label,
    myReservationId: null,
    openTime: "13:00",
    remaining: 10,
    studyPeriod,
    windowState: "closed"
  };
}
