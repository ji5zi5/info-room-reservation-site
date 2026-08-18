import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseActor } from "@/lib/db-context";
import type { SessionUser } from "@/lib/session";

type FindMany = (input: unknown) => Promise<readonly unknown[]>;
type Count = (input: unknown) => Promise<number>;
type ScopedClient = { readonly reservation: { readonly count: Count; readonly findMany: FindMany } };
type WithDatabaseContext = <T>(input: {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: ScopedClient) => Promise<T>;
}) => Promise<T>;

const routeMocks = vi.hoisted(() => ({
  ForbiddenSessionError: class ForbiddenSessionError extends Error {},
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {},
  databaseActorFromSessionUser: vi.fn<(user: SessionUser) => DatabaseActor>(),
  getMockAdminReservations: vi.fn<() => readonly unknown[]>(),
  isNoDatabaseMockMode: vi.fn<() => boolean>(),
  rawReservationFindMany: vi.fn<FindMany>(),
  requireAdmin: vi.fn<() => Promise<SessionUser>>(),
  scopedReservationCount: vi.fn<Count>(),
  scopedReservationFindMany: vi.fn<FindMany>(),
  withDatabaseContext: vi.fn<WithDatabaseContext>()
}));

vi.mock("@/lib/db", () => ({
  prisma: { reservation: { findMany: routeMocks.rawReservationFindMany } }
}));
vi.mock("@/lib/db-context", () => ({
  databaseActorFromSessionUser: routeMocks.databaseActorFromSessionUser,
  withDatabaseContext: routeMocks.withDatabaseContext
}));
vi.mock("@/lib/mock-dev-mode", () => ({ isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode }));
vi.mock("@/lib/mock-reservation-data", () => ({
  getMockAdminReservations: routeMocks.getMockAdminReservations
}));
vi.mock("@/lib/session", () => ({
  ForbiddenSessionError: routeMocks.ForbiddenSessionError,
  UnauthorizedSessionError: routeMocks.UnauthorizedSessionError,
  requireAdmin: routeMocks.requireAdmin
}));
vi.mock("./admin-create-reservation", () => ({ POST: vi.fn() }));

import { GET } from "./route";

const admin = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "admin-read-actor",
  name: "관리자",
  restrictionReason: null,
  restrictedUntil: null,
  role: "ADMIN",
  studentNumber: "90000"
} satisfies SessionUser;

const matchingReservation = {
  createdAt: new Date("2026-06-16T05:00:00.000Z"),
  date: "2026-06-16",
  id: "reservation-matching",
  reason: "자습",
  status: "CONFIRMED",
  studyPeriod: "EIGHTH",
  user: {
    bookingStatus: "ACTIVE",
    id: "student-matching",
    name: "검색 학생",
    role: "STUDENT",
    studentNumber: "31001"
  },
  userId: "student-matching"
};

describe("admin reservation list database actor context", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    routeMocks.databaseActorFromSessionUser.mockReturnValue({ id: admin.id, role: "ADMIN" });
    routeMocks.getMockAdminReservations.mockReturnValue([]);
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.rawReservationFindMany.mockResolvedValue([]);
    routeMocks.requireAdmin.mockResolvedValue(admin);
    routeMocks.scopedReservationCount.mockResolvedValue(0);
    routeMocks.scopedReservationFindMany.mockResolvedValue([]);
    routeMocks.withDatabaseContext.mockImplementation(async (input) =>
      input.operation({ reservation: { count: routeMocks.scopedReservationCount, findMany: routeMocks.scopedReservationFindMany } })
    );
  });

  it("filters a contextual list read using the exact authenticated ADMIN actor", async () => {
    routeMocks.scopedReservationCount.mockResolvedValue(1);
    routeMocks.scopedReservationFindMany.mockResolvedValue([matchingReservation]);

    const response = await GET(
      reservationRequest("status=CONFIRMED&studyPeriod=EIGHTH&query=31001&userId=student-matching")
    );

    expect(response.status).toBe(200);
    expect(routeMocks.databaseActorFromSessionUser).toHaveBeenCalledWith(admin);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledWith({
      actor: { id: admin.id, role: "ADMIN" },
      client: expect.any(Object),
      operation: expect.any(Function)
    });
    expect(routeMocks.scopedReservationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ date: "2026-06-16" }) })
    );
    expect(routeMocks.rawReservationFindMany).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      currentTotalCount: 1,
      items: [expect.objectContaining({ id: matchingReservation.id })],
      nextCursor: null
    });
  });

  it("returns an empty list from an empty contextual exact-id read without a raw protected read", async () => {
    const response = await GET(reservationRequest("reservationId=missing-reservation"));

    expect(response.status).toBe(200);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledOnce();
    expect(routeMocks.scopedReservationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 1,
        where: { id: "missing-reservation" }
      })
    );
    expect(routeMocks.rawReservationFindMany).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ currentTotalCount: 0, items: [], nextCursor: null });
  });

  it("preserves mock mode without opening a database context", async () => {
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);
    routeMocks.getMockAdminReservations.mockReturnValue([matchingReservation]);

    const response = await GET(reservationRequest("status=CONFIRMED"));

    expect(response.status).toBe(200);
    expect(routeMocks.getMockAdminReservations).toHaveBeenCalledOnce();
    expect(routeMocks.withDatabaseContext).not.toHaveBeenCalled();
    expect(routeMocks.rawReservationFindMany).not.toHaveBeenCalled();
  });
});

function reservationRequest(query: string): Request {
  return new Request(`https://example.test/api/admin/reservations?date=2026-06-16&${query}`);
}
