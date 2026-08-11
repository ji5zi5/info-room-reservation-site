import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseActor } from "./db-context";
import type { PeriodSummary } from "./period-settings";

type NotificationFindMany = (input: unknown) => Promise<readonly NotificationDelivery[]>;
type NotificationDelivery = {
  readonly attempts: number;
  readonly date: string;
  readonly failureCode: string | null;
  readonly id: string;
  readonly kind: string;
  readonly lastError: string | null;
  readonly messageId: string | null;
  readonly messageIds: string;
  readonly nextAttemptAt: Date | null;
  readonly sentAt: Date | null;
  readonly status: string;
  readonly studyPeriod: "EIGHTH" | "FIRST";
  readonly updatedAt: Date;
};
type WithDatabaseContext = <T>(input: {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: {
    readonly notificationDelivery: { readonly findMany: NotificationFindMany };
  }) => Promise<T>;
}) => Promise<T>;

const dashboardMocks = vi.hoisted(() => ({
  backlog: vi.fn(async () => []),
  getPeriodSummaries: vi.fn(),
  rawNotificationFindMany: vi.fn<NotificationFindMany>(),
  scopedNotificationFindMany: vi.fn<NotificationFindMany>(),
  toDeliveryRecord: vi.fn(() => ({ messageIds: ["message-1"] })),
  withDatabaseContext: vi.fn<WithDatabaseContext>()
}));

vi.mock("./db", () => ({
  prisma: { notificationDelivery: { findMany: dashboardMocks.rawNotificationFindMany } }
}));
vi.mock("./db-context", () => ({ withDatabaseContext: dashboardMocks.withDatabaseContext }));
vi.mock("./period-settings", () => ({ getPeriodSummaries: dashboardMocks.getPeriodSummaries }));
vi.mock("./prisma-notification-repository", () => ({
  getClosedPeriodNotificationReconciliationBacklog: dashboardMocks.backlog,
  toDeliveryRecord: dashboardMocks.toDeliveryRecord
}));

import { getAdminDashboard } from "./admin-dashboard";

const actor = { id: "admin-dashboard-actor", role: "ADMIN" } satisfies DatabaseActor;
const period = {
  applicants: [{ name: "신청 학생", reservationId: "reservation-1", studentNumber: "31001" }],
  capacity: 10,
  closeTime: "16:20",
  confirmedCount: 1,
  date: "2026-06-12",
  enabled: true,
  label: "8면학",
  myReservationId: null,
  openTime: "13:00",
  remaining: 9,
  studyPeriod: "EIGHTH",
  windowState: "closed"
} satisfies PeriodSummary;

describe("admin dashboard protected reads", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    dashboardMocks.getPeriodSummaries.mockResolvedValue([period]);
    dashboardMocks.rawNotificationFindMany.mockResolvedValue([]);
    dashboardMocks.scopedNotificationFindMany.mockResolvedValue([]);
    dashboardMocks.withDatabaseContext.mockImplementation(async (input) =>
      input.operation({ notificationDelivery: { findMany: dashboardMocks.scopedNotificationFindMany } })
    );
  });

  it("uses the exact ADMIN actor for delivery reads and preserves applicant visibility", async () => {
    const result = await getAdminDashboard("2026-06-12", new Date("2026-06-12T08:00:00.000Z"), actor);

    expect(dashboardMocks.getPeriodSummaries).toHaveBeenCalledWith("2026-06-12", {
      actor,
      includeApplicants: true,
      now: new Date("2026-06-12T08:00:00.000Z")
    });
    expect(dashboardMocks.withDatabaseContext).toHaveBeenCalledWith({
      actor,
      client: expect.any(Object),
      operation: expect.any(Function)
    });
    expect(dashboardMocks.scopedNotificationFindMany).toHaveBeenCalledWith({
      where: { date: "2026-06-12", kind: "CLOSED_LIST" }
    });
    expect(dashboardMocks.rawNotificationFindMany).not.toHaveBeenCalled();
    expect(result.periods[0]?.applicants).toEqual(period.applicants);
  });
});
