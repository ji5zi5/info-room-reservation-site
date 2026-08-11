"use client";

import { useEffect } from "react";

import type { ReservationSidebarUser } from "./reservation-sidebar";

const PERIOD_REFRESH_INTERVAL_MS = 60_000;

type ReservationPeriodAutoRefreshInput = {
  readonly refreshCurrentSummary: () => void;
  readonly refreshMe: () => Promise<void>;
  readonly user: ReservationSidebarUser | null;
  readonly weekStart: string | null;
};

export function useReservationPeriodAutoRefresh(input: ReservationPeriodAutoRefreshInput): void {
  useEffect(() => {
    if (!input.weekStart || !input.user || input.user.role === "ADMIN") {
      return;
    }
    const intervalId = window.setInterval(input.refreshCurrentSummary, PERIOD_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [input.refreshCurrentSummary, input.user?.id, input.user?.role, input.weekStart]);

  useEffect(() => {
    if (!input.weekStart || !input.user || input.user.role === "ADMIN") {
      return;
    }
    const refreshOnVisible = (): void => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void input.refreshMe();
      input.refreshCurrentSummary();
    };
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [input.refreshCurrentSummary, input.refreshMe, input.user?.id, input.user?.role, input.weekStart]);
}
