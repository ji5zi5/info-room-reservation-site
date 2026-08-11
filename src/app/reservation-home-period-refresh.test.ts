import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dispatchPendingReservationAction,
  fetchPeriodSummariesForDate,
  isLatestRequestGeneration,
  isLatestOwnedResourceRequest,
  type OwnedPendingReservationAction,
  type ReservationActionAuthorization
} from "./reservation-home-period-contracts";

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
