"use client";

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
  type PeriodFetchResult
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

const EMPTY_PERIODS: readonly PeriodSummary[] = [];
const EMPTY_PERIODS_BY_DATE: Readonly<Record<string, readonly PeriodSummary[] | undefined>> = {};

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
  readonly refreshPeriodWeek: () => Promise<void>;
  readonly refreshPeriods: (date: string) => Promise<PeriodFetchResult>;
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

  const clearPeriods = useCallback((): void => {
    latestPeriodRefreshRef.current += 1;
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

  const refreshPeriods = useCallback(
    async (date: string): Promise<PeriodFetchResult> => {
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
          commitPeriodFreshness(false, true);
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
        commitPeriodFreshness(true, false);
        setLastRefreshedAt(new Date().toISOString());
        return result;
      } finally {
        endPeriodRefresh();
      }
    },
    [beginPeriodRefresh, commitPeriodFreshness, endPeriodRefresh, getAuthenticationOwner]
  );

  const refreshPeriodWeek = useCallback(async (): Promise<void> => {
    if (!weekStart) {
      return;
    }
    const requestId = latestPeriodRefreshRef.current + 1;
    latestPeriodRefreshRef.current = requestId;
    const owner = getAuthenticationOwner();
    const request = { ...owner, requestGeneration: requestId };
    beginPeriodRefresh();
    try {
      const result = await fetchPeriodSummariesForWeek(weekStart, weekEtagRef.current);
      if (!isLatestOwnedResourceRequest(request, getAuthenticationOwner(), latestPeriodRefreshRef.current)) {
        return;
      }
      if (result.kind === "error") {
        commitPeriodFreshness(false, true);
        return;
      }
      if (result.kind === "not_modified") {
        commitPeriodFreshness(true, false);
        setLastRefreshedAt(new Date().toISOString());
        return;
      }
      weekEtagRef.current = result.etag;
      const next = { ...periodsByDateRef.current, ...result.periodsByDate };
      periodsByDateRef.current = next;
      setCalendarPeriodsByDate(next);
      const targetPeriods = result.periodsByDate[targetDateRef.current];
      if (targetPeriods && !advanceUnavailableRef.current) {
        setPeriods(targetPeriods);
      }
      commitPeriodFreshness(true, false);
      setLastRefreshedAt(new Date().toISOString());
    } finally {
      endPeriodRefresh();
    }
  }, [beginPeriodRefresh, commitPeriodFreshness, endPeriodRefresh, getAuthenticationOwner, weekStart]);

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
      void refreshPeriods(targetDate);
    }
  }, [
    advanceUnavailable,
    calendarPeriodsByDate,
    clearVisiblePeriods,
    clearPeriods,
    refreshPeriods,
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
      void refreshPeriods(currentTargetDate);
    }
  }, [refreshPeriodWeek, refreshPeriods, weekStart]);

  useReservationPeriodAutoRefresh({ refreshCurrentSummary, refreshMe, user, weekStart });

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
    refreshPeriods
  };
}
