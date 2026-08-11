import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReservationActionAuthorization } from "./reservation-home-period-contracts";

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

vi.mock("react", () => ({
  useCallback: <Callback,>(callback: Callback): Callback => callback,
  useState: (initialState: unknown) => [hookRuntime.readState() ?? initialState, hookRuntime.setState]
}));

vi.mock("./use-reservation-submit", () => ({
  useReservationSubmit: () => ({
    reservationSubmitting: false,
    reserve: async () => ({ kind: "success" as const })
  })
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
});

function createActions(toastMessages: string[]) {
  return useStudentReservationActions({
    clearPendingActionRef: { current: () => undefined },
    getReservationActionAuthorization: () => authorization,
    periods: [availablePeriod],
    profileOpen: false,
    refreshMe: async () => undefined,
    refreshPeriods: async (date) => ({ date, kind: "ok", periods: [availablePeriod] }),
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
