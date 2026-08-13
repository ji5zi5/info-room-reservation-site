import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { DatabaseActor } from "@/lib/db-context";
import type { SessionUser } from "@/lib/session";

type FindMany = (input: unknown) => Promise<readonly AdminActionRow[]>;
type Count = (input: unknown) => Promise<number>;
type ScopedClient = { readonly adminAction: { readonly count: Count; readonly findMany: FindMany } };
type WithDatabaseContext = <T>(input: {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: ScopedClient) => Promise<T>;
}) => Promise<T>;
type AdminActionRow = {
  readonly action: string;
  readonly actor: { readonly id: string; readonly name: string; readonly studentNumber: string } | null;
  readonly actorId: string;
  readonly after: string | null;
  readonly before: string | null;
  readonly createdAt: Date;
  readonly id: string;
  readonly reason: string | null;
  readonly reservationId: string | null;
  readonly targetUser: { readonly id: string; readonly name: string; readonly studentNumber: string } | null;
  readonly targetUserId: string | null;
};

const routeMocks = vi.hoisted(() => {
  const rawAdminActionFindMany = vi.fn<FindMany>();
  const rawAdminActionCount = vi.fn<Count>();
  const prismaClient = { adminAction: { count: rawAdminActionCount, findMany: rawAdminActionFindMany } };
  return {
    ForbiddenSessionError: class ForbiddenSessionError extends Error {},
    UnauthorizedSessionError: class UnauthorizedSessionError extends Error {},
    databaseActorFromSessionUser: vi.fn<(user: SessionUser) => DatabaseActor>(),
    isNoDatabaseMockMode: vi.fn<() => boolean>(),
    prismaClient,
    rawAdminActionCount,
    rawAdminActionFindMany,
    requireAdmin: vi.fn<() => Promise<SessionUser>>(),
    scopedAdminActionCount: vi.fn<Count>(),
    scopedAdminActionFindMany: vi.fn<FindMany>(),
    withDatabaseContext: vi.fn<WithDatabaseContext>()
  };
});

vi.mock("@/lib/db", () => ({
  prisma: routeMocks.prismaClient
}));
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

const action = {
  action: "USER_RESTRICTION_APPLY",
  actor: { id: admin.id, name: admin.name, studentNumber: admin.studentNumber },
  actorId: admin.id,
  after: "after",
  before: "before",
  createdAt: new Date("2026-06-16T03:00:00.000Z"),
  id: "action-1",
  reason: "관리 사유",
  reservationId: null,
  targetUser: { id: "student-1", name: "학생", studentNumber: "31001" },
  targetUserId: "student-1"
} satisfies AdminActionRow;

describe("admin actions route", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T01:00:00.000Z"));
    vi.stubEnv("SESSION_SECRET", "todo-12-route-cursor-secret");
    vi.resetAllMocks();
    routeMocks.databaseActorFromSessionUser.mockReturnValue({ id: admin.id, role: "ADMIN" });
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.rawAdminActionCount.mockResolvedValue(0);
    routeMocks.rawAdminActionFindMany.mockResolvedValue([action]);
    routeMocks.requireAdmin.mockResolvedValue(admin);
    routeMocks.scopedAdminActionCount.mockResolvedValue(1);
    routeMocks.scopedAdminActionFindMany.mockResolvedValue([action]);
    routeMocks.withDatabaseContext.mockImplementation(async (input) =>
      input.operation({ adminAction: { count: routeMocks.scopedAdminActionCount, findMany: routeMocks.scopedAdminActionFindMany } })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("returns a strict terminal audit page after server-side filtering", async () => {
    // Given: one matching audit action and its current filtered count.
    const { GET } = await import("./route");

    // When: the first bounded audit page is requested.
    const response = await GET(actionsRequest("action=RESTRICTION&query=31001"));

    // Then: filtering/counting stay inside the authenticated context and the envelope is strict.
    expect(response.status).toBe(200);
    expect(routeMocks.databaseActorFromSessionUser).toHaveBeenCalledWith(admin);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledWith({
      actor: { id: admin.id, role: "ADMIN" }, client: routeMocks.prismaClient, operation: expect.any(Function)
    });
    expect(routeMocks.scopedAdminActionCount).toHaveBeenCalledOnce();
    expect(routeMocks.scopedAdminActionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51
    }));
    expect(routeMocks.rawAdminActionFindMany).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(pagePayload([
      { ...action, category: "RESTRICTION", createdAt: action.createdAt.toISOString() }
    ], 1));
  });

  it("returns only the exact audit action independently of list filters", async () => {
    // Given: an exact action that conflicts with the supplied category and search filters.
    const { GET } = await import("./route");

    // When: the caller requests its exact authorized ID.
    const response = await GET(actionsRequest("action=NO_SHOW&query=missing&actionId=action-1"));

    // Then: the database performs one exact lookup and returns one terminal page.
    expect(routeMocks.scopedAdminActionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 1,
      where: { id: "action-1" }
    }));
    await expect(response.json()).resolves.toMatchObject({
      currentTotalCount: 1,
      items: [expect.objectContaining({ id: "action-1" })],
      nextCursor: null
    });
  });

  it("returns an empty list from an empty contextual action read", async () => {
    // Given: no matching audit actions.
    routeMocks.scopedAdminActionCount.mockResolvedValue(0);
    routeMocks.scopedAdminActionFindMany.mockResolvedValue([]);
    const { GET } = await import("./route");

    // When: the first page is requested.
    const response = await GET(actionsRequest(""));

    // Then: the terminal response keeps all page metadata.
    expect(response.status).toBe(200);
    expect(routeMocks.withDatabaseContext).toHaveBeenCalledOnce();
    expect(routeMocks.scopedAdminActionFindMany).toHaveBeenCalledOnce();
    expect(routeMocks.rawAdminActionFindMany).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(pagePayload([], 0));
  });

  it("keeps the creation cutoff while reporting current filtered total drift", async () => {
    // Given: a first 51-row probe and one mutable row leaving the filter before page two.
    const firstProbe = Array.from({ length: 51 }, (_, index) => ({
      ...action,
      createdAt: new Date(`2026-08-12T00:${String(59 - (index % 50)).padStart(2, "0")}:00.000Z`),
      id: `action-${String(300 - index).padStart(3, "0")}`
    }));
    routeMocks.scopedAdminActionCount.mockResolvedValueOnce(51).mockResolvedValueOnce(50);
    routeMocks.scopedAdminActionFindMany.mockResolvedValueOnce(firstProbe).mockResolvedValueOnce([]);
    const { GET } = await import("./route");
    const firstResponse = await GET(actionsRequest("action=RESTRICTION&query=31001"));
    const firstPage = z.object({ nextCursor: z.string() }).parse(await firstResponse.json());
    vi.setSystemTime(new Date("2026-08-13T01:01:00.000Z"));

    // When: the second page is requested after the current filtered count changes.
    const secondResponse = await GET(actionsRequest(
      `action=RESTRICTION&query=31001&cursor=${encodeURIComponent(firstPage.nextCursor)}`
    ));

    // Then: the original cutoff/expiry remain bound while currentTotalCount truthfully drifts.
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toMatchObject({
      currentTotalCount: 50,
      cutoff: "2026-08-13T01:00:00.000Z",
      expiresAt: "2026-08-13T01:15:00.000Z",
      items: [],
      nextCursor: null
    });
    expect(routeMocks.scopedAdminActionFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
      where: expect.objectContaining({ createdAt: { lte: new Date("2026-08-13T01:00:00.000Z") } })
    }));
  });

  it("traverses every filtered audit action beyond the former cap with route-issued cursors", async () => {
    // Given: 227 filtered actions sharing a timestamp, requiring descending ID continuation on every page.
    const fixture = Array.from({ length: 227 }, (_unused, index) => ({
      ...action,
      createdAt: new Date("2026-08-12T00:00:00.000Z"),
      id: `cursor-action-${String(227 - index).padStart(3, "0")}`,
      reason: `cursor audit ${index + 1}`
    }));
    routeMocks.scopedAdminActionCount.mockResolvedValue(fixture.length);
    routeMocks.scopedAdminActionFindMany
      .mockResolvedValueOnce(fixture.slice(0, 51))
      .mockResolvedValueOnce(fixture.slice(50, 101))
      .mockResolvedValueOnce(fixture.slice(100, 151))
      .mockResolvedValueOnce(fixture.slice(150, 201))
      .mockResolvedValueOnce(fixture.slice(200));
    const pageSchema = z.object({
      cutoff: z.string(),
      currentTotalCount: z.number(),
      items: z.array(z.object({ id: z.string() })),
      nextCursor: z.string().nullable()
    });
    const seenIds: string[] = [];
    let cursor: string | null = null;
    let pageCount = 0;
    const { GET } = await import("./route");

    // When: each request feeds the route's signed nextCursor into the same constrained filter URL.
    do {
      const query = new URLSearchParams({ action: "RESTRICTION", query: "cursor" });
      if (cursor !== null) query.set("cursor", cursor);
      const response = await GET(actionsRequest(query.toString()));
      expect(response.status).toBe(200);
      const page = pageSchema.parse(await response.json());
      expect(page.cutoff).toBe("2026-08-13T01:00:00.000Z");
      expect(page.currentTotalCount).toBe(227);
      seenIds.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pageCount += 1;
    } while (cursor !== null);

    // Then: the descending tuple, filter/cutoff and terminal null preserve all action IDs without repeats.
    expect(pageCount).toBe(5);
    expect(seenIds).toEqual(fixture.map((entry) => entry.id));
    expect(new Set(seenIds).size).toBe(fixture.length);
    expect(routeMocks.scopedAdminActionFindMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
      where: expect.objectContaining({
        action: { in: ["USER_RESTRICTION_APPLY", "USER_RESTRICTION_REMOVE"] },
        createdAt: { lte: new Date("2026-08-13T01:00:00.000Z") }
      })
    }));
    expect(routeMocks.scopedAdminActionFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
      where: expect.objectContaining({
        OR: [
          { createdAt: { lt: new Date("2026-08-12T00:00:00.000Z") } },
          { createdAt: new Date("2026-08-12T00:00:00.000Z"), id: { lt: "cursor-action-178" } }
        ]
      })
    }));
    expect(routeMocks.scopedAdminActionFindMany).toHaveBeenNthCalledWith(5, expect.objectContaining({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
      where: expect.objectContaining({
        OR: [
          { createdAt: { lt: new Date("2026-08-12T00:00:00.000Z") } },
          { createdAt: new Date("2026-08-12T00:00:00.000Z"), id: { lt: "cursor-action-028" } }
        ]
      })
    }));
  });

  it("returns a controlled typed error for a malformed authenticated cursor", async () => {
    // Given: an otherwise valid filter request carrying a non-canonical cursor.
    const { GET } = await import("./route");

    // When: the cursor crosses the authenticated parser boundary.
    const response = await GET(actionsRequest("action=ALL&query=&cursor=not-a-signed-cursor"));

    // Then: the route rejects it before any action query and preserves the typed cursor code.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "CURSOR_MALFORMED" } });
    expect(routeMocks.scopedAdminActionCount).not.toHaveBeenCalled();
    expect(routeMocks.scopedAdminActionFindMany).not.toHaveBeenCalled();
  });

  it.each([
    { code: "unauthorized", error: new routeMocks.UnauthorizedSessionError(), status: 401 },
    { code: "forbidden", error: new routeMocks.ForbiddenSessionError(), status: 403 }
  ])("preserves the $status admin session error response", async ({ code, error, status }) => {
    routeMocks.requireAdmin.mockRejectedValue(error);
    const { GET } = await import("./route");

    const response = await GET(actionsRequest(""));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(routeMocks.withDatabaseContext).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected contextual action read error", async () => {
    routeMocks.scopedAdminActionFindMany.mockRejectedValue(new Error("action read failed"));
    const { GET } = await import("./route");

    await expect(GET(actionsRequest(""))).rejects.toThrow("action read failed");
    expect(routeMocks.rawAdminActionFindMany).not.toHaveBeenCalled();
  });
});

function actionsRequest(query: string): Request {
  return new Request(`https://example.test/api/admin/actions?${query}`);
}

function pagePayload(items: readonly object[], currentTotalCount: number): object {
  return {
    cutoff: "2026-08-13T01:00:00.000Z",
    currentTotalCount,
    expiresAt: "2026-08-13T01:15:00.000Z",
    items,
    nextCursor: null
  };
}
