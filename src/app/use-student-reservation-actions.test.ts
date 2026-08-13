import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReservationActionAuthorization } from "./reservation-home-period-contracts";
import type { ReservationStateRefreshResult } from "./reservation-home-period-refresh";

type HookRuntime = {
  readonly events: string[];
  readState: () => unknown;
  reset: () => void;
  setState: (value: unknown) => void;
};

const hookRuntime = vi.hoisted<HookRuntime>(() => {
  let state: unknown = null;
  const events: string[] = [];

  return {
    events,
    readState: () => state,
    reset: () => {
      state = null;
      events.length = 0;
    },
    setState: (value: unknown) => {
      events.push("pending action");
      state = value;
    }
  };
});

const csrfFetchMock = vi.hoisted(() => vi.fn());

vi.mock("react", () => ({
  useCallback: <Callback,>(callback: Callback): Callback => callback,
  useState: (initialState: unknown) => [hookRuntime.readState() ?? initialState, hookRuntime.setState]
}));

vi.mock("./csrf-fetch", () => ({
  csrfFetch: csrfFetchMock
}));

import { useStudentReservationActions } from "./use-student-reservation-actions";

const authorization = {
  authenticationGeneration: 1,
  periodFresh: true,
  sessionFresh: true,
  userId: "student-1"
} satisfies ReservationActionAuthorization;

const availablePeriod = {
  capacity: 10,
  closeTime: "16:20",
  confirmedCount: 0,
  date: "2026-08-10",
  enabled: true,
  label: "8면학",
  myReservationId: null,
  openTime: "13:00",
  remaining: 10,
  studyPeriod: "EIGHTH",
  windowState: "open"
} as const;

describe("useStudentReservationActions", () => {
  beforeEach(() => {
    hookRuntime.reset();
    csrfFetchMock.mockReset();
  });

  it("clears the stale toast before opening a reserve confirmation", async () => {
    // Given
    const toastMessages: string[] = [];
    const actions = createActions(toastMessages);

    // When
    await actions.requestReserve("EIGHTH");

    // Then
    expect(toastMessages).toEqual([""]);
    expect(hookRuntime.events).toEqual(["toast cleared", "pending action"]);
    expect(hookRuntime.readState()).toMatchObject({ action: { kind: "reserve" }, authorization });
  });

  it("clears the stale toast before opening a cancel confirmation", () => {
    // Given
    const toastMessages: string[] = [];
    const actions = createActions(toastMessages);

    // When
    actions.requestCancel("reservation-1");

    // Then
    expect(toastMessages).toEqual([""]);
    expect(hookRuntime.events).toEqual(["toast cleared", "pending action"]);
    expect(hookRuntime.readState()).toMatchObject({
      action: { kind: "cancel", reservationId: "reservation-1" },
      authorization
    });
  });

  it("does not report settled cancellation success when coordinated freshness remains stale", async () => {
    // Given
    csrfFetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const toastMessages: string[] = [];
    const refreshReservationState = vi.fn<(
      date: string,
      getFreshness: () => ReservationActionAuthorization
    ) => Promise<ReservationStateRefreshResult>>().mockResolvedValue({
      date: "2026-08-10",
      kind: "stale",
      periodFresh: false
    });
    createActions(toastMessages, { refreshReservationState }).requestCancel("reservation-1");
    const actions = createActions(toastMessages, { refreshReservationState });

    // When
    const outcome = await actions.confirmPendingAction({ kind: "cancel" });

    // Then
    expect(outcome).toEqual({ kind: "error" });
    expect(toastMessages).not.toContain("예약이 취소되었습니다. 3일간 예약이 제한됩니다.");
    expect(refreshReservationState).toHaveBeenCalledOnce();
  });

  it("awaits one coordinated refresh before reporting settled cancellation success", async () => {
    // Given
    csrfFetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const toastMessages: string[] = [];
    const heldRefresh = deferred<ReservationStateRefreshResult>();
    const refreshStarted = deferred<void>();
    const refreshMe = vi.fn();
    const refreshReservationState = vi.fn<(
      date: string,
      getFreshness: () => ReservationActionAuthorization
    ) => Promise<ReservationStateRefreshResult>>().mockImplementation(() => {
      refreshStarted.resolve();
      return heldRefresh.promise;
    });
    createActions(toastMessages, { refreshMe, refreshReservationState }).requestCancel("reservation-1");
    let outcome: unknown;

    // When
    const confirmation = createActions(toastMessages, { refreshMe, refreshReservationState })
      .confirmPendingAction({ kind: "cancel" })
      .then((result) => {
        outcome = result;
      });
    await refreshStarted.promise;

    // Then
    expect(outcome).toBeUndefined();
    expect(toastMessages).not.toContain("예약이 취소되었습니다. 3일간 예약이 제한됩니다.");
    expect(refreshReservationState).toHaveBeenCalledOnce();
    expect(refreshMe).not.toHaveBeenCalled();
    heldRefresh.resolve({ date: "2026-08-10", kind: "settled", periods: [availablePeriod] });
    await confirmation;
    expect(outcome).toEqual({ kind: "success" });
    expect(toastMessages).toContain("예약이 취소되었습니다. 3일간 예약이 제한됩니다.");
  });

  it("awaits one post-mutation coordinated refresh before reporting settled reservation success", async () => {
    // Given
    csrfFetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    const toastMessages: string[] = [];
    const heldRefresh = deferred<ReservationStateRefreshResult>();
    const refreshStarted = deferred<void>();
    const refreshMe = vi.fn();
    const refreshReservationState = vi.fn<(
      date: string,
      getFreshness: () => ReservationActionAuthorization
    ) => Promise<ReservationStateRefreshResult>>()
      .mockResolvedValueOnce({ date: "2026-08-10", kind: "settled", periods: [availablePeriod] })
      .mockImplementationOnce(() => {
        refreshStarted.resolve();
        return heldRefresh.promise;
      });
    await createActions(toastMessages, { refreshMe, refreshReservationState }).requestReserve("EIGHTH");
    refreshReservationState.mockClear();
    let outcome: unknown;

    // When
    const confirmation = createActions(toastMessages, { refreshMe, refreshReservationState })
      .confirmPendingAction({ kind: "reserve", reason: "수행평가 준비" })
      .then((result) => {
        outcome = result;
      });
    await refreshStarted.promise;

    // Then
    expect(outcome).toBeUndefined();
    expect(toastMessages).not.toContain("예약이 확정되었습니다.");
    expect(refreshReservationState).toHaveBeenCalledOnce();
    expect(refreshMe).not.toHaveBeenCalled();
    heldRefresh.resolve({ date: "2026-08-10", kind: "settled", periods: [availablePeriod] });
    await confirmation;
    expect(outcome).toEqual({ kind: "success" });
    expect(toastMessages).toContain("예약이 확정되었습니다.");
  });
});

function createActions(
  toastMessages: string[],
  overrides: {
    readonly refreshMe?: () => Promise<void>;
    readonly refreshReservationState?: (
      date: string,
      getFreshness: () => ReservationActionAuthorization
    ) => Promise<ReservationStateRefreshResult>;
  } = {}
) {
  return useStudentReservationActions({
    clearPendingActionRef: { current: () => undefined },
    getReservationActionAuthorization: () => authorization,
    periods: [availablePeriod],
    profileOpen: false,
    refreshMe: overrides.refreshMe ?? (async () => undefined),
    refreshPeriods: overrides.refreshReservationState ?? (async (date) => ({
      date,
      kind: "settled",
      periods: [availablePeriod]
    })),
    refreshProfile: async () => undefined,
    setLoading: () => undefined,
    setToast: (message) => {
      toastMessages.push(message);
      if (message === "") {
        hookRuntime.events.push("toast cleared");
      }
    },
    targetDate: "2026-08-10",
    user: null
  });
}

function deferred<Value>() {
  let resolvePromise: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
