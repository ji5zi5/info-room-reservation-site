"use client";
// allow: SIZE_OK — cohesive period/session refresh coordinator constrained to the Todo 14 write set.

import { useCallback, useEffect, useRef, useState } from "react";

import type { PeriodSummary } from "@/components/reservation-period-card";
import type { getAdvanceReservationPolicy } from "@/lib/advance-reservation-policy";
import {
  fetchPeriodSummariesForDate,
  fetchPeriodSummariesForWeek,
  isLatestOwnedResourceRequest,
  isSchoolWeekDate,
  periodWeekStart,
  type AuthenticationOwner,
  type PeriodFetchResult,
  type PeriodWeekFetchResult
} from "./reservation-home-period-contracts";
import type { ReservationSidebarUser } from "./reservation-sidebar";
import { useReservationPeriodAutoRefresh } from "./use-reservation-period-auto-refresh";

type AdvanceReservationPolicy = ReturnType<typeof getAdvanceReservationPolicy>;
type PeriodState =
  | readonly PeriodSummary[]
  | Readonly<Record<string, readonly PeriodSummary[] | undefined>>;
type PeriodResourceOwner = {
  readonly role: ReservationSidebarUser["role"] | null;
  readonly userId: string | null;
  readonly weekStart: string | null;
};

type ReservationStateFreshness = {
  readonly sessionFresh: boolean;
};

export type ReservationStateRefreshResult =
  | { readonly date: string; readonly kind: "settled"; readonly periods: readonly PeriodSummary[] | null }
  | { readonly date: string; readonly kind: "stale"; readonly periodFresh: boolean };

type RefreshReservationStateInput = {
  readonly date: string;
  readonly isCurrentRequest: () => boolean;
  readonly isSessionFresh: () => boolean;
  readonly markFreshnessUnknown: () => void;
  readonly refreshMe: () => Promise<boolean>;
  readonly refreshPeriodDate: (date: string) => Promise<PeriodFetchResult>;
  readonly refreshPeriodWeek: () => Promise<PeriodWeekFetchResult>;
  readonly weekStart: string | null;
};

const EMPTY_PERIODS: readonly PeriodSummary[] = [];
const EMPTY_PERIODS_BY_DATE: Readonly<Record<string, readonly PeriodSummary[] | undefined>> = {};

export async function refreshReservationState(
  input: RefreshReservationStateInput
): Promise<ReservationStateRefreshResult> {
  input.markFreshnessUnknown();
  const periodRefresh = input.weekStart && isSchoolWeekDate(input.date, input.weekStart)
    ? input.refreshPeriodWeek().then((result): PeriodFetchResult => {
        switch (result.kind) {
          case "error":
            return { date: input.date, kind: "error" };
          case "not_modified":
            return { date: input.date, kind: "not_modified" };
          case "ok":
            return { date: input.date, kind: "ok", periods: result.periodsByDate[input.date] ?? [] };
        }
      })
    : input.refreshPeriodDate(input.date);
  const [periodResult, sessionAccepted] = await Promise.all([periodRefresh, input.refreshMe()]);
  const periodFresh = periodResult.kind !== "error";
  if (!sessionAccepted || !input.isCurrentRequest() || !input.isSessionFresh() || !periodFresh) {
    return { date: input.date, kind: "stale", periodFresh };
  }
  return {
    date: input.date,
    kind: "settled",
    periods: periodResult.kind === "ok" ? periodResult.periods : null
  };
}

function clearPeriodState<State extends PeriodState>(current: State, emptyState: State): State {
  const isEmpty = Array.isArray(current) ? current.length === 0 : Object.keys(current).length === 0;
  return isEmpty ? current : emptyState;
}

type UseReservationPeriodRefreshInput = {
  readonly advancePolicy: AdvanceReservationPolicy | null;
  readonly advanceUnavailable: boolean;
  readonly getAuthenticationOwner: () => AuthenticationOwner;
  readonly refreshMe: () => Promise<void>;
  readonly targetDate: string;
  readonly user: ReservationSidebarUser | null;
};

type UseReservationPeriodRefreshResult = {
  readonly calendarPeriodsByDate: Readonly<Record<string, readonly PeriodSummary[] | undefined>>;
  readonly clearPeriods: () => void;
  readonly getPeriodFreshness: () => boolean;
  readonly lastRefreshedAt: string | null;
  readonly periods: readonly PeriodSummary[];
  readonly periodError: boolean;
  readonly periodFresh: boolean;
  readonly periodsRefreshing: boolean;
  readonly refreshPeriodWeek: () => Promise<PeriodWeekFetchResult>;
  readonly refreshPeriods: (
    date: string,
    getFreshness: () => ReservationStateFreshness
  ) => Promise<ReservationStateRefreshResult>;
};

export function useReservationPeriodRefresh({
  advancePolicy,
  advanceUnavailable,
  getAuthenticationOwner,
  refreshMe,
  targetDate,
  user
}: UseReservationPeriodRefreshInput): UseReservationPeriodRefreshResult {
  const [periods, setPeriods] = useState<readonly PeriodSummary[]>([]);
  const [calendarPeriodsByDate, setCalendarPeriodsByDate] = useState<
    Readonly<Record<string, readonly PeriodSummary[] | undefined>>
  >({});
  const [periodsRefreshing, setPeriodsRefreshing] = useState(false);
  const [periodFresh, setPeriodFresh] = useState(false);
  const [periodError, setPeriodError] = useState(false);
  const periodFreshRef = useRef(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const activePeriodRefreshesRef = useRef(0);
  const latestPeriodRefreshRef = useRef(0);
  const latestReservationStateRefreshRef = useRef(0);
  const latestSessionRefreshRef = useRef(0);
  const weekEtagRef = useRef<string | null>(null);
  const targetDateRef = useRef(targetDate);
  const advanceUnavailableRef = useRef(advanceUnavailable);
  const periodsByDateRef = useRef<Readonly<Record<string, readonly PeriodSummary[] | undefined>>>({});
  const periodResourceOwnerRef = useRef<PeriodResourceOwner>({ role: null, userId: null, weekStart: null });
  const weekStart = periodWeekStart(advancePolicy);
  targetDateRef.current = targetDate;
  advanceUnavailableRef.current = advanceUnavailable;

  const commitPeriodFreshness = useCallback((fresh: boolean, error: boolean): void => {
    periodFreshRef.current = fresh;
    setPeriodFresh(fresh);
    setPeriodError(error);
  }, []);

  const getPeriodFreshness = useCallback((): boolean => periodFreshRef.current, []);

  const refreshTrackedSession = useCallback(async (): Promise<boolean> => {
    const requestGeneration = latestSessionRefreshRef.current + 1;
    latestSessionRefreshRef.current = requestGeneration;
    await refreshMe();
    return requestGeneration === latestSessionRefreshRef.current;
  }, [refreshMe]);

  const refreshTrackedSessionWithoutResult = useCallback(async (): Promise<void> => {
    await refreshTrackedSession();
  }, [refreshTrackedSession]);

  const clearPeriods = useCallback((): void => {
    latestPeriodRefreshRef.current += 1;
    latestReservationStateRefreshRef.current += 1;
    setPeriods((current) => clearPeriodState(current, EMPTY_PERIODS));
    setCalendarPeriodsByDate((current) => clearPeriodState(current, EMPTY_PERIODS_BY_DATE));
    periodsByDateRef.current = clearPeriodState(periodsByDateRef.current, EMPTY_PERIODS_BY_DATE);
    weekEtagRef.current = null;
    commitPeriodFreshness(false, false);
  }, [commitPeriodFreshness]);

  const clearVisiblePeriods = useCallback((): void => {
    setPeriods((current) => clearPeriodState(current, EMPTY_PERIODS));
  }, []);

  const beginPeriodRefresh = useCallback((): void => {
    activePeriodRefreshesRef.current += 1;
    setPeriodsRefreshing(true);
  }, []);

  const endPeriodRefresh = useCallback((): void => {
    activePeriodRefreshesRef.current = Math.max(0, activePeriodRefreshesRef.current - 1);
    if (activePeriodRefreshesRef.current === 0) {
      setPeriodsRefreshing(false);
    }
  }, []);

  const refreshPeriodDate = useCallback(
    async (date: string, settleFreshness = true): Promise<PeriodFetchResult> => {
      if (!date) {
        return { date, kind: "error" };
      }
      const requestId = latestPeriodRefreshRef.current + 1;
      latestPeriodRefreshRef.current = requestId;
      const owner = getAuthenticationOwner();
      const request = { ...owner, requestGeneration: requestId };
      beginPeriodRefresh();
      try {
        const result = await fetchPeriodSummariesForDate(date);
        if (!isLatestOwnedResourceRequest(request, getAuthenticationOwner(), latestPeriodRefreshRef.current)) {
          return { date, kind: "error" };
        }
        if (result.kind === "error") {
          if (settleFreshness) {
            commitPeriodFreshness(false, true);
          }
          return result;
        }
        if (result.kind === "ok") {
          const next = { ...periodsByDateRef.current, [date]: result.periods };
          periodsByDateRef.current = next;
          setCalendarPeriodsByDate(next);
          if (date === targetDateRef.current && !advanceUnavailableRef.current) {
            setPeriods(result.periods);
          }
        }
        if (settleFreshness) {
          commitPeriodFreshness(true, false);
        }
        setLastRefreshedAt(new Date().toISOString());
        return result;
      } finally {
        endPeriodRefresh();
      }
    },
    [beginPeriodRefresh, commitPeriodFreshness, endPeriodRefresh, getAuthenticationOwner]
  );

  const refreshPeriodWeek = useCallback(async (settleFreshness = true): Promise<PeriodWeekFetchResult> => {
    if (!weekStart) {
      return { kind: "error" };
    }
    const requestId = latestPeriodRefreshRef.current + 1;
    latestPeriodRefreshRef.current = requestId;
    const owner = getAuthenticationOwner();
    const request = { ...owner, requestGeneration: requestId };
    beginPeriodRefresh();
    try {
      const result = await fetchPeriodSummariesForWeek(weekStart, weekEtagRef.current);
      if (!isLatestOwnedResourceRequest(request, getAuthenticationOwner(), latestPeriodRefreshRef.current)) {
        return { kind: "error" };
      }
      if (result.kind === "error") {
        if (settleFreshness) {
          commitPeriodFreshness(false, true);
        }
        return result;
      }
      if (result.kind === "not_modified") {
        if (settleFreshness) {
          commitPeriodFreshness(true, false);
        }
        setLastRefreshedAt(new Date().toISOString());
        return result;
      }
      weekEtagRef.current = result.etag;
      const next = { ...periodsByDateRef.current, ...result.periodsByDate };
      periodsByDateRef.current = next;
      setCalendarPeriodsByDate(next);
      const targetPeriods = result.periodsByDate[targetDateRef.current];
      if (targetPeriods && !advanceUnavailableRef.current) {
        setPeriods(targetPeriods);
      }
      if (settleFreshness) {
        commitPeriodFreshness(true, false);
      }
      setLastRefreshedAt(new Date().toISOString());
      return result;
    } finally {
      endPeriodRefresh();
    }
  }, [beginPeriodRefresh, commitPeriodFreshness, endPeriodRefresh, getAuthenticationOwner, weekStart]);

  const refreshReservationStateForDate = useCallback((
    date: string,
    getFreshness: () => ReservationStateFreshness
  ): Promise<ReservationStateRefreshResult> => {
    const requestGeneration = latestReservationStateRefreshRef.current + 1;
    latestReservationStateRefreshRef.current = requestGeneration;
    const owner = getAuthenticationOwner();
    const request = { ...owner, requestGeneration };
    return refreshReservationState({
      date,
      isCurrentRequest: () => isLatestOwnedResourceRequest(
        request,
        getAuthenticationOwner(),
        latestReservationStateRefreshRef.current
      ),
      isSessionFresh: () => getFreshness().sessionFresh,
      markFreshnessUnknown: () => commitPeriodFreshness(false, false),
      refreshMe: refreshTrackedSession,
      refreshPeriodDate: (targetDate) => refreshPeriodDate(targetDate, false),
      refreshPeriodWeek: () => refreshPeriodWeek(false),
      weekStart
    }).then((result) => {
      if (isLatestOwnedResourceRequest(request, getAuthenticationOwner(), latestReservationStateRefreshRef.current)) {
        const fresh = result.kind === "settled" || result.periodFresh;
        commitPeriodFreshness(fresh, !fresh);
      }
      return result;
    });
  }, [commitPeriodFreshness, getAuthenticationOwner, refreshPeriodDate, refreshPeriodWeek, refreshTrackedSession, weekStart]);

  useEffect(() => {
    const nextOwner: PeriodResourceOwner = { role: user?.role ?? null, userId: user?.id ?? null, weekStart };
    const previousOwner = periodResourceOwnerRef.current;
    const ownerChanged =
      previousOwner.role !== nextOwner.role ||
      previousOwner.userId !== nextOwner.userId ||
      previousOwner.weekStart !== nextOwner.weekStart;
    if (ownerChanged) {
      clearPeriods();
      periodResourceOwnerRef.current = nextOwner;
    }
    if (!user || user.role === "ADMIN" || !weekStart) {
      return;
    }
    void refreshPeriodWeek();
  }, [clearPeriods, refreshPeriodWeek, user?.id, user?.role, weekStart]);

  useEffect(() => {
    if (!user || user.role === "ADMIN" || !targetDate || advanceUnavailable) {
      clearPeriods();
      return;
    }
    const targetPeriods = periodsByDateRef.current[targetDate];
    if (targetPeriods) {
      setPeriods(targetPeriods);
      return;
    }
    clearVisiblePeriods();
    if (!weekStart || !isSchoolWeekDate(targetDate, weekStart)) {
      void refreshPeriodDate(targetDate);
    }
  }, [
    advanceUnavailable,
    calendarPeriodsByDate,
    clearVisiblePeriods,
    clearPeriods,
    refreshPeriodDate,
    targetDate,
    user?.id,
    user?.role,
    weekStart
  ]);

  const refreshCurrentSummary = useCallback((): void => {
    if (document.visibilityState !== "visible") {
      return;
    }
    const currentTargetDate = targetDateRef.current;
    if (weekStart && isSchoolWeekDate(currentTargetDate, weekStart)) {
      void refreshPeriodWeek();
      return;
    }
    if (currentTargetDate) {
      void refreshPeriodDate(currentTargetDate);
    }
  }, [refreshPeriodDate, refreshPeriodWeek, weekStart]);

  useReservationPeriodAutoRefresh({
    refreshCurrentSummary,
    refreshMe: refreshTrackedSessionWithoutResult,
    user,
    weekStart
  });

  return {
    calendarPeriodsByDate,
    clearPeriods,
    getPeriodFreshness,
    lastRefreshedAt,
    periods,
    periodError,
    periodFresh,
    periodsRefreshing,
    refreshPeriodWeek,
    refreshPeriods: refreshReservationStateForDate
  };
}
