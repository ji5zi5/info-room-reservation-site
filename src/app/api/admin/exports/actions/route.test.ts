import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseActor } from "@/lib/db-context";
import type { SessionUser } from "@/lib/session";

type ActionRow = ReturnType<typeof actionRow>;
type FindMany = (input: unknown) => Promise<readonly ActionRow[]>;
type ScopedClient = { readonly adminAction: { readonly findMany: FindMany } };
type WithDatabaseContext = <T>(input: {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: ScopedClient) => Promise<T>;
}) => Promise<T>;

const routeMocks = vi.hoisted(() => {
  const rawFindMany = vi.fn<FindMany>();
  const prismaClient = { adminAction: { findMany: rawFindMany } };
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

describe("admin audit CSV export route", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T01:00:00.000Z"));
    vi.resetAllMocks();
    routeMocks.requireAdmin.mockResolvedValue(admin);
    routeMocks.databaseActorFromSessionUser.mockReturnValue({ id: admin.id, role: "ADMIN" });
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.scopedFindMany.mockResolvedValue([actionRow("action-1")]);
    routeMocks.withDatabaseContext.mockImplementation(async (input) =>
      input.operation({ adminAction: { findMany: routeMocks.scopedFindMany } })
    );
  });

  afterEach(() => vi.useRealTimers());

  it("exports the page filter and order through one bounded request-time query", async () => {
    // Given: one matching restriction audit action.
    const { GET } = await import("./route");

    // When: the filtered audit CSV is requested.
    const response = await GET(new Request(
      "https://example.test/api/admin/exports/actions?action=RESTRICTION&query=31001"
    ));

    // Then: the shared category/search/cutoff query produces an exact BOM-prefixed CSV download.
    expect(routeMocks.scopedFindMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 10_001,
      where: expect.objectContaining({
        action: { in: ["USER_RESTRICTION_APPLY", "USER_RESTRICTION_REMOVE"] },
        createdAt: { lte: new Date("2026-08-13T01:00:00.000Z") }
      })
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="admin-audit-actions.csv"');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes.slice(3))).toBe(
      "시각,분류,액션,처리자,처리자학번,대상,대상학번,사유,예약ID\n" +
      "2026-08-13T00:00:00.000Z,RESTRICTION,USER_RESTRICTION_APPLY,관리자,90000,학생,31001,관리 사유,"
    );
  });

  it("returns a typed 422 after probing exactly 10,001 matching actions", async () => {
    // Given: the bounded audit probe exceeds the ceiling by one row.
    routeMocks.scopedFindMany.mockResolvedValue(Array.from({ length: 10_001 }, (_, index) => actionRow(`a-${index}`)));
    const { GET } = await import("./route");

    // When: the export is requested.
    const response = await GET(new Request("https://example.test/api/admin/exports/actions?action=ALL"));

    // Then: the route returns the stable typed ceiling error instead of partial CSV.
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "ADMIN_EXPORT_TOO_LARGE", message: "내보내기는 10,000행까지 가능합니다." }
    });
  });
});

function actionRow(id: string) {
  return {
    action: "USER_RESTRICTION_APPLY",
    actor: { id: "admin-1", name: "관리자", studentNumber: "90000" },
    actorId: "admin-1",
    after: null,
    before: null,
    createdAt: new Date("2026-08-13T00:00:00.000Z"),
    id,
    reason: "관리 사유",
    reservationId: null,
    targetUser: { id: "user-1", name: "학생", studentNumber: "31001" },
    targetUserId: "user-1"
  } as const;
}
