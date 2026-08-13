import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAdminAuditActions, fetchAdminReservations, fetchAdminUsers } from "./admin-read-api-client";

describe("admin read api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serializes an optional reservationId alongside the independent reservation read input", async () => {
    // Given: an exact reservation lookup and a terminal strict page response.
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>().mockResolvedValue(
      new Response(JSON.stringify(page([])), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    // When: the client performs the exact lookup.
    await fetchAdminReservations({
      date: "2026-06-16",
      query: "",
      reservationId: "deep-link-target-101",
      status: "CONFIRMED",
      studyPeriod: "ALL"
    });

    // Then: the exact ID is serialized independently from list filters.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/reservations?date=2026-06-16&query=&status=CONFIRMED&studyPeriod=ALL&reservationId=deep-link-target-101",
      undefined
    );
  });

  it("traverses every bounded user page until nextCursor is null", async () => {
    // Given: 127 users split across three authenticated page envelopes.
    const users = Array.from({ length: 127 }, (_, index) => user(`user-${index + 1}`));
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify(page(users.slice(0, 50), "cursor-2", 127)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page(users.slice(50, 100), "cursor-3", 127)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page(users.slice(100), null, 127)), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // When: the array-compatible client reads the filtered user collection.
    const result = await fetchAdminUsers({ query: "학생", status: "ALL" });

    // Then: all 127 rows are returned in server order and each cursor is forwarded once.
    expect(result).toEqual({ data: users, kind: "ok" });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/admin/users?bookingStatus=ALL&query=%ED%95%99%EC%83%9D", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/users?bookingStatus=ALL&query=%ED%95%99%EC%83%9D&cursor=cursor-2",
      undefined
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/admin/users?bookingStatus=ALL&query=%ED%95%99%EC%83%9D&cursor=cursor-3",
      undefined
    );
  });

  it("traverses all 127 filtered reservations without an old cap", async () => {
    // Given: 127 reservations split into bounded server pages.
    const reservations = Array.from({ length: 127 }, (_, index) => reservation(`reservation-${index + 1}`));
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify(page(reservations.slice(0, 50), "r-2", 127)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page(reservations.slice(50, 100), "r-3", 127)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page(reservations.slice(100), null, 127)), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // When: the array-compatible reservation reader follows the cursor chain.
    const result = await fetchAdminReservations({
      date: "2026-08-13",
      query: "",
      status: "ALL",
      studyPeriod: "ALL"
    });

    // Then: all 127 rows survive in server order and every JSON response remains page-bounded.
    expect(result).toEqual({ data: reservations, kind: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("traverses all 227 filtered audit actions without an old cap", async () => {
    // Given: 227 audit actions split into five bounded server pages.
    const actions = Array.from({ length: 227 }, (_, index) => auditAction(`action-${index + 1}`));
    const cursors = ["a-2", "a-3", "a-4", "a-5", null] as const;
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
    for (let index = 0; index < cursors.length; index += 1) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(
        page(actions.slice(index * 50, (index + 1) * 50), cursors[index], 227)
      ), { status: 200 }));
    }
    vi.stubGlobal("fetch", fetchMock);

    // When: the audit reader follows every authenticated continuation.
    const result = await fetchAdminAuditActions({ action: "ALL", query: "" });

    // Then: all 227 actions are returned and traversal stops only at terminal null.
    expect(result).toEqual({ data: actions, kind: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("returns a controlled error for a legacy or malformed page envelope", async () => {
    // Given: a successful HTTP response using the removed capped-list shape.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ users: [] }), { status: 200 })
    ));

    // When: the strict read client parses the untrusted response.
    const read = fetchAdminUsers({ query: "", status: "ALL" });

    // Then: contract drift is surfaced as a controlled read error instead of an uncaught parser exception.
    await expect(read).resolves.toMatchObject({ kind: "error" });
  });

  it("serializes exact user and audit IDs without traversing a substitute page", async () => {
    // Given: two exact reads that both return terminal empty pages.
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementation(async () => new Response(JSON.stringify(page([])), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // When: the client requests an exact user and exact action beside conflicting list filters.
    const userResult = await fetchAdminUsers({ query: "missing", status: "BANNED", userId: "user-127" });
    const actionResult = await fetchAdminAuditActions({ action: "NO_SHOW", actionId: "action-227", query: "missing" });

    // Then: each ID is sent once and terminal empty results never trigger substitute pagination.
    expect(userResult).toEqual({ data: [], kind: "ok" });
    expect(actionResult).toEqual({ data: [], kind: "ok" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/admin/users?bookingStatus=BANNED&query=missing&userId=user-127",
      undefined
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/actions?action=NO_SHOW&query=missing&actionId=action-227",
      undefined
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function page(items: readonly unknown[], nextCursor: string | null = null, currentTotalCount = items.length): object {
  return {
    cutoff: "2026-08-13T01:00:00.000Z",
    currentTotalCount,
    expiresAt: "2026-08-13T01:15:00.000Z",
    items,
    nextCursor
  };
}

function user(id: string): object {
  return {
    bookingStatus: "ACTIVE",
    generation: 31,
    id,
    name: `학생 ${id}`,
    restrictedUntil: null,
    restrictionReason: null,
    role: "STUDENT",
    shadowBanProfile: "NORMAL",
    studentNumber: id
  };
}

function reservation(id: string): object {
  return {
    createdAt: "2026-08-13T00:00:00.000Z",
    date: "2026-08-13",
    id,
    reason: null,
    status: "CONFIRMED",
    studyPeriod: "EIGHTH",
    user: {
      bookingStatus: "ACTIVE",
      id: "user-1",
      name: "학생",
      role: "STUDENT",
      studentNumber: "31001"
    }
  };
}

function auditAction(id: string): object {
  return {
    action: "USER_RESTRICTION_APPLY",
    actor: { id: "admin-1", name: "관리자", studentNumber: "90000" },
    actorId: "admin-1",
    after: null,
    before: null,
    category: "RESTRICTION",
    createdAt: "2026-08-13T00:00:00.000Z",
    id,
    reason: null,
    reservationId: null,
    targetUser: null,
    targetUserId: null
  };
}
