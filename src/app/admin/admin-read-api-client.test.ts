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
    const result = await fetchAdminReservations({
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
    expect(result).toEqual({ data: page([]), kind: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches exactly one user page and forwards only a caller-supplied cursor", async () => {
    // Given: two page envelopes with distinct metadata.
    const firstPage = page([user("user-1")], "cursor-2", 127);
    const secondPage = page([user("user-2")], null, 126, "2026-08-13T01:15:00.000Z");
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify(firstPage), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(secondPage), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // When: the caller requests page one, then explicitly supplies its continuation.
    const firstResult = await fetchAdminUsers({ query: "학생", status: "ALL" });
    const secondResult = await fetchAdminUsers({ cursor: "cursor-2", query: "학생", status: "ALL" });

    // Then: each call makes one request and preserves its complete page metadata.
    expect(firstResult).toEqual({ data: firstPage, kind: "ok" });
    expect(secondResult).toEqual({ data: secondPage, kind: "ok" });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/admin/users?bookingStatus=ALL&query=%ED%95%99%EC%83%9D", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/users?bookingStatus=ALL&query=%ED%95%99%EC%83%9D&cursor=cursor-2",
      undefined
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetches exactly one reservation page with caller-owned continuation and metadata", async () => {
    // Given: a non-terminal reservation page.
    const reservationPage = page([reservation("reservation-51")], "reservation-cursor-2", 127);
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(JSON.stringify(reservationPage), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // When: the caller explicitly requests that page.
    const result = await fetchAdminReservations({
      cursor: "reservation-cursor-1",
      date: "2026-08-13",
      query: "",
      status: "ALL",
      studyPeriod: "ALL"
    });

    // Then: the envelope is preserved and no internal continuation occurs.
    expect(result).toEqual({ data: reservationPage, kind: "ok" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/reservations?date=2026-08-13&query=&status=ALL&studyPeriod=ALL&cursor=reservation-cursor-1",
      undefined
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches exactly one audit page with caller-owned continuation and metadata", async () => {
    // Given: a non-terminal audit page.
    const auditPage = page([auditAction("action-51")], "audit-cursor-2", 227);
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(JSON.stringify(auditPage), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // When: the caller explicitly requests that page.
    const result = await fetchAdminAuditActions({ action: "ALL", cursor: "audit-cursor-1", query: "" });

    // Then: the envelope is preserved and no internal continuation occurs.
    expect(result).toEqual({ data: auditPage, kind: "ok" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/actions?action=ALL&query=&cursor=audit-cursor-1",
      undefined
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(userResult).toEqual({ data: page([]), kind: "ok" });
    expect(actionResult).toEqual({ data: page([]), kind: "ok" });
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

function page(
  items: readonly unknown[],
  nextCursor: string | null = null,
  currentTotalCount = items.length,
  expiresAt = "2026-08-13T01:15:00.000Z"
): object {
  return {
    cutoff: "2026-08-13T01:00:00.000Z",
    currentTotalCount,
    expiresAt,
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
