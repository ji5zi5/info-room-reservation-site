"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { PeriodSummary } from "@/components/reservation-period-card";
import type { getAdvanceReservationPolicy } from "@/lib/advance-reservation-policy";
import { addDays } from "@/lib/date";
import { buildReservationCalendarDays } from "@/lib/reservation-calendar";
import { readPeriodSummaries, readPeriodWeekPayload } from "./client-api-response";
import { toPeriodSummariesByDate } from "./reservation-period-week";
import type { ReservationSidebarUser } from "./reservation-sidebar";

type AdvanceReservationPolicy = ReturnType<typeof getAdvanceReservationPolicy>;
type PeriodFetchResult =
  | {
      readonly date: string;
      readonly kind: "ok";
      readonly periods: readonly PeriodSummary[];
    }
  | {
      readonly date: string;
      readonly kind: "error";
    };
type PeriodWeekFetchResult =
  | {
      readonly etag: string | null;
      readonly kind: "ok";
      readonly periodsByDate: Readonly<Record<string, readonly PeriodSummary[]>>;
    }
  | {
      readonly kind: "not_modified";
    }
  | {
      readonly kind: "error";
    };

type UseReservationPeriodRefreshInput = {
  readonly advancePolicy: AdvanceReservationPolicy | null;
  readonly advanceUnavailable: boolean;
  readonly refreshMe: () => Promise<void>;
  readonly targetDate: string;
  readonly user: ReservationSidebarUser | null;
};

type UseReservationPeriodRefreshResult = {
  readonly calendarPeriodsByDate: Readonly<Record<string, readonly PeriodSummary[] | undefined>>;
  readonly clearPeriods: () => void;
  readonly lastRefreshedAt: string | null;
  readonly periods: readonly PeriodSummary[];
  readonly periodsRefreshing: boolean;
  readonly refreshPeriods: (date: string) => Promise<readonly PeriodSummary[]>;
};

const PERIOD_REFRESH_INTERVAL_MS = 60_000;

export function useReservationPeriodRefresh({
  advancePolicy,
  advanceUnavailable,
  refreshMe,
  targetDate,
  user
}: UseReservationPeriodRefreshInput): UseReservationPeriodRefreshResult {
  const [periods, setPeriods] = useState<readonly PeriodSummary[]>([]);
  const [calendarPeriodsByDate, setCalendarPeriodsByDate] = useState<
    Readonly<Record<string, readonly PeriodSummary[] | undefined>>
  >({});
  const [periodsRefreshing, setPeriodsRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const activePeriodRefreshesRef = useRef(0);
  const latestPeriodRefreshRef = useRef(0);
  const weekEtagRef = useRef<string | null>(null);
  const targetDateRef = useRef(targetDate);
  const advanceUnavailableRef = useRef(advanceUnavailable);
  const weekStart = periodWeekStart(advancePolicy);
  targetDateRef.current = targetDate;
  advanceUnavailableRef.current = advanceUnavailable;

  const clearPeriods = useCallback((): void => {
    setPeriods([]);
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
    async (date: string): Promise<readonly PeriodSummary[]> => {
      if (!date) {
        return [];
      }
      const requestId = latestPeriodRefreshRef.current + 1;
      latestPeriodRefreshRef.current = requestId;
      beginPeriodRefresh();
      try {
        const result = await fetchPeriodSummariesForDate(date);
        if (result.kind === "error" || requestId !== latestPeriodRefreshRef.current) {
          return [];
        }
        setCalendarPeriodsByDate((current) => ({ ...current, [date]: result.periods }));
        if (date === targetDateRef.current && !advanceUnavailableRef.current) {
          setPeriods(result.periods);
        }
        setLastRefreshedAt(new Date().toISOString());
        return result.periods;
      } finally {
        endPeriodRefresh();
      }
    },
    [beginPeriodRefresh, endPeriodRefresh]
  );

  const refreshPeriodWeek = useCallback(async (): Promise<void> => {
    if (!weekStart) {
      return;
    }
    const requestId = latestPeriodRefreshRef.current + 1;
    latestPeriodRefreshRef.current = requestId;
    beginPeriodRefresh();
    try {
      const result = await fetchPeriodSummariesForWeek(weekStart, weekEtagRef.current);
      if (result.kind === "error" || requestId !== latestPeriodRefreshRef.current) {
        return;
      }
      if (result.kind === "not_modified") {
        setLastRefreshedAt(new Date().toISOString());
        return;
      }
      weekEtagRef.current = result.etag;
      setCalendarPeriodsByDate((current) => ({ ...current, ...result.periodsByDate }));
      const targetPeriods = result.periodsByDate[targetDateRef.current];
      if (targetPeriods && !advanceUnavailableRef.current) {
        setPeriods(targetPeriods);
      }
      setLastRefreshedAt(new Date().toISOString());
    } finally {
      endPeriodRefresh();
    }
  }, [beginPeriodRefresh, endPeriodRefresh, weekStart]);

  useEffect(() => {
    weekEtagRef.current = null;
  }, [user?.id, weekStart]);

  useEffect(() => {
    if (!user || user.role === "ADMIN" || !weekStart) {
      setCalendarPeriodsByDate({});
      clearPeriods();
      return;
    }
    void refreshPeriodWeek();
  }, [clearPeriods, refreshPeriodWeek, user?.id, user?.role, weekStart]);

  useEffect(() => {
    if (!user || user.role === "ADMIN" || !targetDate || advanceUnavailable) {
      clearPeriods();
      return;
    }
    const targetPeriods = calendarPeriodsByDate[targetDate];
    if (targetPeriods) {
      setPeriods(targetPeriods);
      return;
    }
    clearPeriods();
    if (!weekStart || !isSchoolWeekDate(targetDate, weekStart)) {
      void refreshPeriods(targetDate);
    }
  }, [
    advanceUnavailable,
    calendarPeriodsByDate,
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

  useEffect(() => {
    if (!weekStart || !user || user.role === "ADMIN") {
      return;
    }
    const intervalId = window.setInterval(refreshCurrentSummary, PERIOD_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [refreshCurrentSummary, user?.id, user?.role, weekStart]);

  useEffect(() => {
    if (!weekStart || !user || user.role === "ADMIN") {
      return;
    }
    const refreshOnVisible = (): void => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void refreshMe();
      refreshCurrentSummary();
    };
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [refreshCurrentSummary, refreshMe, user?.id, user?.role, weekStart]);

  return {
    calendarPeriodsByDate,
    clearPeriods,
    lastRefreshedAt,
    periods,
    periodsRefreshing,
    refreshPeriods
  };
}

async function fetchPeriodSummariesForWeek(
  weekStart: string,
  etag: string | null
): Promise<PeriodWeekFetchResult> {
  try {
    const url = `/api/periods?weekStart=${encodeURIComponent(weekStart)}`;
    const response = await (etag ? fetch(url, { headers: { "If-None-Match": etag } }) : fetch(url));
    if (response.status === 304) {
      return { kind: "not_modified" };
    }
    const payload = await readPeriodWeekPayload(response);
    if (!payload) {
      return { kind: "error" };
    }
    return {
      etag: response.headers.get("ETag"),
      kind: "ok",
      periodsByDate: toPeriodSummariesByDate(payload)
    };
  } catch {
    return { kind: "error" };
  }
}

async function fetchPeriodSummariesForDate(date: string): Promise<PeriodFetchResult> {
  try {
    const response = await fetch(`/api/periods?date=${encodeURIComponent(date)}`);
    if (!response.ok) {
      return { date, kind: "error" };
    }
    return { date, kind: "ok", periods: await readPeriodSummaries(response) };
  } catch {
    return { date, kind: "error" };
  }
}

function periodWeekStart(policy: AdvanceReservationPolicy | null): string | null {
  if (!policy) {
    return null;
  }
  return buildReservationCalendarDays(policy)[0]?.date ?? null;
}

function isSchoolWeekDate(date: string, weekStart: string): boolean {
  return date >= weekStart && date <= addDays(weekStart, 4);
}
