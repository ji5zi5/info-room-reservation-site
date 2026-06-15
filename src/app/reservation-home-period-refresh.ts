"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { PeriodSummary } from "@/components/reservation-period-card";
import type { getAdvanceReservationPolicy } from "@/lib/advance-reservation-policy";
import { buildReservationCalendarDays } from "@/lib/reservation-calendar";
import { readPeriodSummaries } from "./client-api-response";
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

  const refreshPeriodDates = useCallback(
    async (dates: readonly string[], currentTargetDate?: string): Promise<readonly PeriodSummary[]> => {
      const uniqueDates = [...new Set(dates.filter(Boolean))];
      if (uniqueDates.length === 0) {
        return [];
      }
      beginPeriodRefresh();
      try {
        const entries = await Promise.all(uniqueDates.map(fetchPeriodSummariesForDate));
        const successfulEntries = entries.filter(
          (entry): entry is Extract<PeriodFetchResult, { readonly kind: "ok" }> => entry.kind === "ok"
        );
        if (successfulEntries.length > 0) {
          const nextByDate = Object.fromEntries(successfulEntries.map((entry) => [entry.date, entry.periods] as const));
          setCalendarPeriodsByDate((current) => ({ ...current, ...nextByDate }));
          if (currentTargetDate && Object.hasOwn(nextByDate, currentTargetDate)) {
            setPeriods(nextByDate[currentTargetDate] ?? []);
          }
          setLastRefreshedAt(new Date().toISOString());
        }
        const targetEntry = entries.find((entry) => entry.date === currentTargetDate);
        return targetEntry?.kind === "ok" ? targetEntry.periods : [];
      } finally {
        endPeriodRefresh();
      }
    },
    [beginPeriodRefresh, endPeriodRefresh]
  );

  const refreshPeriods = useCallback(
    async (date: string): Promise<readonly PeriodSummary[]> => refreshPeriodDates([date], date),
    [refreshPeriodDates]
  );

  useEffect(() => {
    if (!user || !targetDate || user.role === "ADMIN") {
      setCalendarPeriodsByDate({});
      clearPeriods();
      return;
    }
    if (advanceUnavailable) {
      clearPeriods();
      return;
    }
    void refreshPeriodDates(visiblePeriodDates(advancePolicy, targetDate), targetDate);
  }, [advancePolicy, advanceUnavailable, clearPeriods, refreshPeriodDates, targetDate, user?.id, user?.role]);

  useEffect(() => {
    if (!advancePolicy || !user || user.role === "ADMIN") {
      return;
    }
    const refreshVisibleDates = (): void => {
      void refreshPeriodDates(visiblePeriodDates(advancePolicy, targetDate), advanceUnavailable ? undefined : targetDate);
    };
    const intervalId = window.setInterval(refreshVisibleDates, PERIOD_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [advancePolicy, advanceUnavailable, refreshPeriodDates, targetDate, user?.id, user?.role]);

  useEffect(() => {
    if (!advancePolicy || !user || user.role === "ADMIN") {
      return;
    }
    const refreshOnVisible = (): void => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void refreshMe();
      void refreshPeriodDates(visiblePeriodDates(advancePolicy, targetDate), advanceUnavailable ? undefined : targetDate);
    };
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [advancePolicy, advanceUnavailable, refreshMe, refreshPeriodDates, targetDate, user?.id, user?.role]);

  return {
    calendarPeriodsByDate,
    clearPeriods,
    lastRefreshedAt,
    periods,
    periodsRefreshing,
    refreshPeriods
  };
}

async function fetchPeriodSummariesForDate(date: string): Promise<PeriodFetchResult> {
  try {
    const response = await fetch(`/api/periods?date=${date}`);
    if (!response.ok) {
      return { date, kind: "error" };
    }
    return { date, kind: "ok", periods: await readPeriodSummaries(response) };
  } catch {
    return { date, kind: "error" };
  }
}

function selectableCalendarDates(policy: AdvanceReservationPolicy): readonly string[] {
  return buildReservationCalendarDays(policy)
    .filter((day) => day.selectable)
    .map((day) => day.date);
}

function visiblePeriodDates(policy: AdvanceReservationPolicy | null, targetDate: string): readonly string[] {
  return policy ? [targetDate, ...selectableCalendarDates(policy)] : [targetDate];
}
