import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dispatchPendingReservationAction,
  fetchPeriodSummariesForDate,
  isLatestRequestGeneration,
  isLatestOwnedResourceRequest,
  type OwnedPendingReservationAction,
  type ReservationActionAuthorization
} from "./reservation-home-period-contracts";
import { refreshReservationState } from "./reservation-home-period-refresh";

describe("pending reservation action live wiring", () => {
  const freshAuthorization = {
    authenticationGeneration: 7,
    periodFresh: true,
    sessionFresh: true,
    userId: "student-a"
  } satisfies ReservationActionAuthorization;

  it.each([
    ["reserve", { ...freshAuthorization, sessionFresh: false }],
    ["reserve", { ...freshAuthorization, periodFresh: false }],
    ["reserve", { ...freshAuthorization, authenticationGeneration: 8 }],
    ["reserve", { ...freshAuthorization, userId: "student-b" }],
    ["cancel", { ...freshAuthorization, sessionFresh: false }],
    ["cancel", { ...freshAuthorization, periodFresh: false }],
    ["cancel", { ...freshAuthorization, authenticationGeneration: 8 }],
    ["cancel", { ...freshAuthorization, userId: "student-b" }]
  ] as const)("blocks a pending %s before submission when confirmation authorization changed", (kind, current) => {
    // Given
    const onCancel = vi.fn();
    const onReserve = vi.fn();
    const pending = pendingAction(kind, freshAuthorization);

    // When
    const result = dispatchPendingReservationAction({
      currentAuthorization: current,
      onCancel,
      onReserve,
      pending,
      submittedInput: kind === "reserve" ? { kind, reason: "수행평가 준비" } : { kind }
    });

    // Then
    expect(result).toEqual({ kind: "blocked" });
    expect(onReserve).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("submits a pending reserve exactly once when owner and both freshness states still match", () => {
    // Given
    const onReserve = vi.fn();

    // When
    const result = dispatchPendingReservationAction({
      currentAuthorization: freshAuthorization,
      onCancel: vi.fn(),
      onReserve,
      pending: pendingAction("reserve", freshAuthorization),
      submittedInput: { kind: "reserve", reason: "수행평가 준비" }
    });

    // Then
    expect(result).toEqual({ kind: "submitted" });
    expect(onReserve).toHaveBeenCalledOnce();
    expect(onReserve).toHaveBeenCalledWith("EIGHTH", "수행평가 준비");
  });

  it("submits a pending cancel exactly once when owner and both freshness states still match", () => {
    // Given
    const onCancel = vi.fn();

    // When
    const result = dispatchPendingReservationAction({
      currentAuthorization: freshAuthorization,
      onCancel,
      onReserve: vi.fn(),
      pending: pendingAction("cancel", freshAuthorization),
      submittedInput: { kind: "cancel" }
    });

    // Then
    expect(result).toEqual({ kind: "submitted" });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledWith("reservation-a");
  });
});

const SAME_USER = {
  bookingStatus: "ACTIVE",
  generation: 3,
  id: "student-a",
  name: "학생 A",
  restrictionReason: null,
  restrictedUntil: null,
  role: "STUDENT",
  studentNumber: "32001"
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isLatestOwnedResourceRequest", () => {
  it("accepts only the latest generation under the same authentication owner", () => {
    // Given
    const request = { authenticationGeneration: 7, requestGeneration: 11, userId: SAME_USER.id };

    // When / Then
    const currentOwner = { authenticationGeneration: 7, userId: SAME_USER.id };
    expect(isLatestOwnedResourceRequest(request, currentOwner, 11)).toBe(true);
    expect(isLatestOwnedResourceRequest(request, currentOwner, 12)).toBe(false);
  });
});

function pendingAction(
  kind: "cancel" | "reserve",
  authorization: ReservationActionAuthorization
): OwnedPendingReservationAction {
  if (kind === "cancel") {
    return {
      action: {
        kind,
        label: "8면학",
        reservationId: "reservation-a",
        restrictedUntilPreview: "2026-06-14T00:00:00.000Z"
      },
      authorization
    };
  }
  return { action: { kind, label: "8면학", studyPeriod: "EIGHTH" }, authorization };
}

describe("isLatestRequestGeneration", () => {
  it("rejects an older session response after a newer session generation starts", () => {
    // Given / When / Then
    expect(isLatestRequestGeneration(12, 13)).toBe(false);
    expect(isLatestRequestGeneration(13, 13)).toBe(true);
  });
});

describe("fetchPeriodSummariesForDate", () => {
  it("preserves 304 as not_modified", async () => {
    // Given
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 304 })));

    // When / Then
    await expect(fetchPeriodSummariesForDate("2026-06-11")).resolves.toEqual({
      date: "2026-06-11",
      kind: "not_modified"
    });
  });

  it("preserves an empty periods array from a valid 200 as authoritative success", async () => {
    // Given
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ periods: [] }), { status: 200 }))
    );

    // When / Then
    await expect(fetchPeriodSummariesForDate("2026-06-11")).resolves.toEqual({
      date: "2026-06-11",
      kind: "ok",
      periods: []
    });
  });

  it.each([
    ["malformed", new Response("{bad-json", { status: 200 })],
    ["server error", new Response(null, { status: 500 })]
  ])("returns error for %s responses", async (_scenario, response) => {
    // Given
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    // When / Then
    await expect(fetchPeriodSummariesForDate("2026-06-11")).resolves.toEqual({
      date: "2026-06-11",
      kind: "error"
    });
  });
});

describe("refreshReservationState", () => {
  it("awaits the active school week and /api/me before reporting settled freshness", async () => {
    // Given
    const week = deferred<{
      readonly etag: null;
      readonly kind: "ok";
      readonly periodsByDate: Readonly<Record<string, readonly []>>;
    }>();
    const me = deferred<void>();
    const events: string[] = [];
    let outcome: unknown;

    // When
    const refresh = refreshReservationState({
      date: "2026-06-11",
      isCurrentRequest: () => true,
      isSessionFresh: () => true,
      markFreshnessUnknown: () => events.push("unknown"),
      refreshMe: async () => { await me.promise; return true; },
      refreshPeriodDate: vi.fn(),
      refreshPeriodWeek: () => week.promise,
      weekStart: "2026-06-08"
    }).then((result) => {
      outcome = result;
    });
    week.resolve({ etag: null, kind: "ok", periodsByDate: { "2026-06-11": [] } });
    await Promise.resolve();

    // Then
    expect(events).toEqual(["unknown"]);
    expect(outcome).toBeUndefined();
    me.resolve();
    await refresh;
    expect(outcome).toEqual({ date: "2026-06-11", kind: "settled", periods: [] });
  });

  it("refreshes only the exact date outside the active school week and still awaits /api/me", async () => {
    // Given
    const exactDate = deferred<{ readonly date: string; readonly kind: "not_modified" }>();
    const me = deferred<void>();
    const refreshWeek = vi.fn();

    // When
    const refresh = refreshReservationState({
      date: "2026-06-15",
      isCurrentRequest: () => true,
      isSessionFresh: () => true,
      markFreshnessUnknown: vi.fn(),
      refreshMe: async () => { await me.promise; return true; },
      refreshPeriodDate: () => exactDate.promise,
      refreshPeriodWeek: refreshWeek,
      weekStart: "2026-06-08"
    });
    exactDate.resolve({ date: "2026-06-15", kind: "not_modified" });
    me.resolve();

    // Then
    await expect(refresh).resolves.toEqual({ date: "2026-06-15", kind: "settled", periods: null });
    expect(refreshWeek).not.toHaveBeenCalled();
  });

  it.each([
    ["period refresh", false, true],
    ["session refresh", true, false],
    ["stale owner", true, true]
  ] as const)("keeps freshness unsettled after a failed %s", async (scenario, periodFresh, sessionFresh) => {
    // Given
    const result = await refreshReservationState({
      date: "2026-06-11",
      isCurrentRequest: () => scenario !== "stale owner",
      isSessionFresh: () => sessionFresh,
      markFreshnessUnknown: vi.fn(),
      refreshMe: async () => true,
      refreshPeriodDate: vi.fn(),
      refreshPeriodWeek: async () => periodFresh
        ? { kind: "not_modified" }
        : { kind: "error" },
      weekStart: "2026-06-08"
    });

    // Then
    expect(result).toEqual({ date: "2026-06-11", kind: "stale", periodFresh });
  });

  it("rejects settled freshness when its own session response loses the accepted-commit race", async () => {
    // Given
    const sessions = createSessionRefreshHarness();
    const coordinatorMe = deferred<void>();
    const newerMe = deferred<void>();
    const week = deferred<{ readonly kind: "not_modified" }>();
    const coordinatorRefreshMe = sessions.start(coordinatorMe.promise);
    const refresh = refreshReservationState({
      date: "2026-06-11",
      isCurrentRequest: () => true,
      isSessionFresh: sessions.isFresh,
      markFreshnessUnknown: vi.fn(),
      refreshMe: coordinatorRefreshMe,
      refreshPeriodDate: vi.fn(),
      refreshPeriodWeek: () => week.promise,
      weekStart: "2026-06-08"
    });
    const newerRefresh = sessions.start(newerMe.promise)();

    // When
    coordinatorMe.resolve();
    await coordinatorRefreshMe();
    week.resolve({ kind: "not_modified" });

    // Then
    await expect(refresh).resolves.toEqual({ date: "2026-06-11", kind: "stale", periodFresh: true });
    expect(sessions.isFresh()).toBe(true);
    newerMe.resolve();
    await newerRefresh;
  });

  it("rejects a held coordinator after a newer request generation settles", async () => {
    // Given
    const firstWeek = deferred<{ readonly kind: "not_modified" }>();
    let latestGeneration = 1;
    const first = refreshReservationState({
      date: "2026-06-11",
      isCurrentRequest: () => latestGeneration === 1,
      isSessionFresh: () => true,
      markFreshnessUnknown: vi.fn(),
      refreshMe: async () => true,
      refreshPeriodDate: vi.fn(),
      refreshPeriodWeek: () => firstWeek.promise,
      weekStart: "2026-06-08"
    });

    // When
    latestGeneration = 2;
    const second = refreshReservationState({
      date: "2026-06-11",
      isCurrentRequest: () => latestGeneration === 2,
      isSessionFresh: () => true,
      markFreshnessUnknown: vi.fn(),
      refreshMe: async () => true,
      refreshPeriodDate: vi.fn(),
      refreshPeriodWeek: async () => ({ kind: "not_modified" }),
      weekStart: "2026-06-08"
    });
    firstWeek.resolve({ kind: "not_modified" });

    // Then
    await expect(second).resolves.toEqual({ date: "2026-06-11", kind: "settled", periods: null });
    await expect(first).resolves.toEqual({ date: "2026-06-11", kind: "stale", periodFresh: true });
  });
});

function deferred<Value>() {
  let resolvePromise: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function createSessionRefreshHarness() {
  let latestRequestGeneration = 0;
  let fresh = true;
  return {
    isFresh: () => fresh,
    start: (response: Promise<void>) => {
      const requestGeneration = latestRequestGeneration + 1;
      latestRequestGeneration = requestGeneration;
      const refresh = async (): Promise<boolean> => {
        await response;
        const accepted = requestGeneration === latestRequestGeneration;
        if (accepted) {
          fresh = true;
        }
        return accepted;
      };
      return refresh;
    }
  };
}
