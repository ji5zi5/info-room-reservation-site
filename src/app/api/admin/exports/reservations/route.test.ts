import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseActor } from "@/lib/db-context";
import type { SessionUser } from "@/lib/session";

type ReservationRow = ReturnType<typeof reservationRow>;
type FindMany = (input: unknown) => Promise<readonly ReservationRow[]>;
type ScopedClient = { readonly reservation: { readonly findMany: FindMany } };
type WithDatabaseContext = <T>(input: {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: ScopedClient) => Promise<T>;
}) => Promise<T>;

const routeMocks = vi.hoisted(() => {
  const rawFindMany = vi.fn<FindMany>();
  const prismaClient = { reservation: { findMany: rawFindMany } };
  return {
    ForbiddenSessionError: class ForbiddenSessionError extends Error {},
    UnauthorizedSessionError: class UnauthorizedSessionError extends Error {},
    databaseActorFromSessionUser: vi.fn<(user: SessionUser) => DatabaseActor>(),
    isNoDatabaseMockMode: vi.fn<() => boolean>(),
    prismaClient,
    rawFindMany,
    requireAdmin: vi.fn<() => Promise<SessionUser>>(),
    scopedFindMany: vi.fn<FindMany>(),
    withDatabaseContext: vi.fn<WithDatabaseContext>()
  };
});

vi.mock("@/lib/db", () => ({ prisma: routeMocks.prismaClient }));
vi.mock("@/lib/db-context", () => ({
  databaseActorFromSessionUser: routeMocks.databaseActorFromSessionUser,
  withDatabaseContext: routeMocks.withDatabaseContext
}));
vi.mock("@/lib/mock-dev-mode", () => ({ isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode }));
vi.mock("@/lib/mock-reservation-data", () => ({ getMockAdminReservations: vi.fn(() => []) }));
vi.mock("@/lib/session", () => ({
  ForbiddenSessionError: routeMocks.ForbiddenSessionError,
  UnauthorizedSessionError: routeMocks.UnauthorizedSessionError,
  requireAdmin: routeMocks.requireAdmin
}));

const admin = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "admin-1",
  name: "관리자",
  restrictionReason: null,
  restrictedUntil: null,
  role: "ADMIN",
  studentNumber: "90000"
} satisfies SessionUser;

describe("admin reservation CSV export route", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T01:00:00.000Z"));
    vi.resetAllMocks();
    routeMocks.requireAdmin.mockResolvedValue(admin);
    routeMocks.databaseActorFromSessionUser.mockReturnValue({ id: admin.id, role: "ADMIN" });
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.scopedFindMany.mockResolvedValue([reservationRow("reservation-1")]);
    routeMocks.withDatabaseContext.mockImplementation(async (input) =>
      input.operation({ reservation: { findMany: routeMocks.scopedFindMany } })
    );
  });

  afterEach(() => vi.useRealTimers());

  it("exports one request-time filtered query with BOM and download headers", async () => {
    // Given: one reservation matching the requested date, status, period, and student query.
    const { GET } = await import("./route");

    // When: the filtered CSV export is requested.
    const response = await GET(new Request(
      "https://example.test/api/admin/exports/reservations?date=2026-08-13&status=CONFIRMED&studyPeriod=EIGHTH&query=31001"
    ));

    // Then: the bounded Prisma query and CSV preserve the page parser, order, filters, and download contract.
    expect(routeMocks.scopedFindMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ studyPeriod: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 10_001,
      where: expect.objectContaining({
        createdAt: { lte: new Date("2026-08-13T01:00:00.000Z") },
        date: "2026-08-13",
        status: "CONFIRMED",
        studyPeriod: "EIGHTH"
      })
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="admin-reservations.csv"');
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes.slice(3))).toBe(
      "날짜,시간대,상태,이름,학번,사유\n2026-08-13,8면학,CONFIRMED,학생,31001,자습"
    );
  });

  it("returns a typed 422 after probing exactly 10,001 matching rows", async () => {
    // Given: the bounded probe finds one row above the export ceiling.
    routeMocks.scopedFindMany.mockResolvedValue(Array.from({ length: 10_001 }, (_, index) => reservationRow(`r-${index}`)));
    const { GET } = await import("./route");

    // When: the export is requested.
    const response = await GET(new Request("https://example.test/api/admin/exports/reservations?date=2026-08-13"));

    // Then: no partial CSV is returned and the stable typed error identifies the ceiling.
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "ADMIN_EXPORT_TOO_LARGE", message: "내보내기는 10,000행까지 가능합니다." }
    });
  });
});

function reservationRow(id: string) {
  return {
    createdAt: new Date("2026-08-13T00:00:00.000Z"),
    date: "2026-08-13",
    id,
    reason: "자습",
    status: "CONFIRMED",
    studyPeriod: "EIGHTH",
    user: { bookingStatus: "ACTIVE", id: "user-1", name: "학생", role: "STUDENT", studentNumber: "31001" }
  } as const;
}
