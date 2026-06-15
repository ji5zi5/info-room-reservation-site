"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getAdvanceReservationPolicy } from "@/lib/advance-reservation-policy";
import { buildReservationCalendarDays } from "@/lib/reservation-calendar";
import {
  collectStudentCurrentReservations,
  previewCancellationRestrictedUntil
} from "@/lib/student-reservation-status";
import type { PeriodSummary } from "@/components/reservation-period-card";
import type { ReservationPendingAction } from "@/components/reservation-action-dialog";
import { AdminConsole } from "./admin/admin-console";
import { readApiErrorMessage, readCurrentUser, readLoginPayload, readPeriodSummaries, readStudentProfilePayload } from "./client-api-response";
import { csrfFetch, resetCsrfToken } from "./csrf-fetch";
import { consumeAdminRedirectMessage, reservationRestrictionMessage } from "./reservation-home-helpers";
import { ReservationHomeView, type ReservationHomeProfileState, type ReservationHomeTab } from "./reservation-home-view";
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

const PERIOD_REFRESH_INTERVAL_MS = 60_000;
const EMPTY_PROFILE_STATE: ReservationHomeProfileState = { errorMessage: null, loading: false, open: false, profile: null };

export function ReservationHomePage(): React.ReactElement {
  const [user, setUser] = useState<ReservationSidebarUser | null>(null);
  const [periods, setPeriods] = useState<readonly PeriodSummary[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [tab, setTab] = useState<ReservationHomeTab>("today");
  const [advancePolicy, setAdvancePolicy] = useState<AdvanceReservationPolicy | null>(null);
  const [advanceDate, setAdvanceDate] = useState("");
  const [calendarPeriodsByDate, setCalendarPeriodsByDate] = useState<{
    readonly [date: string]: readonly PeriodSummary[] | undefined;
  }>({});
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [periodsRefreshing, setPeriodsRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<ReservationPendingAction | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const activePeriodRefreshesRef = useRef(0);
  const profileRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const [profileState, setProfileState] = useState<ReservationHomeProfileState>(EMPTY_PROFILE_STATE);

  const isAdmin = user?.role === "ADMIN";
  const advanceUnavailable = tab === "advance" && advancePolicy?.kind === "unavailable";
  const todayDate = advancePolicy?.today ?? "";
  const targetDate = tab === "advance" ? advanceDate : todayDate;
  const currentReservations = collectStudentCurrentReservations(calendarPeriodsByDate);

  const refreshMe = useCallback(async (): Promise<void> => {
    const response = await fetch("/api/me");
    setUser(await readCurrentUser(response));
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
    void refreshMe();
    const adminMessage = consumeAdminRedirectMessage();
    if (adminMessage) {
      setToast(adminMessage);
    }
  }, [refreshMe]);

  useEffect(() => {
    const policy = getAdvanceReservationPolicy(new Date());
    setAdvancePolicy(policy);
    setAdvanceDate(policy.kind === "available" ? policy.minDate : policy.today);
  }, []);

  useEffect(() => {
    if (!user || !targetDate || user.role === "ADMIN") {
      return;
    }
    if (advanceUnavailable) {
      setPeriods([]);
      return;
    }
    void refreshPeriods(targetDate);
  }, [advanceUnavailable, refreshPeriods, targetDate, user?.id, user?.role]);

  useEffect(() => {
    if (!advancePolicy || !user || user.role === "ADMIN") {
      setCalendarPeriodsByDate({});
      return;
    }

    void refreshPeriodDates(selectableCalendarDates(advancePolicy), advanceUnavailable ? undefined : targetDate);
  }, [advancePolicy, advanceUnavailable, refreshPeriodDates, targetDate, user?.id, user?.role]);

  useEffect(() => {
    if (!advancePolicy || !user || user.role === "ADMIN") {
      return;
    }
    const refreshVisibleDates = (): void => {
      void refreshPeriodDates(selectableCalendarDates(advancePolicy), advanceUnavailable ? undefined : targetDate);
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
      void refreshPeriodDates(selectableCalendarDates(advancePolicy), advanceUnavailable ? undefined : targetDate);
    };
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [advancePolicy, advanceUnavailable, refreshMe, refreshPeriodDates, targetDate, user?.id, user?.role]);

  async function refreshProfile(): Promise<void> {
    if (profileRefreshPromiseRef.current) {
      await profileRefreshPromiseRef.current;
      return;
    }
    const refresh = (async (): Promise<void> => {
      setProfileState((current) => ({ ...current, errorMessage: null, loading: true }));
      const result = await readStudentProfilePayload(await fetch("/api/me/profile"));
      switch (result.kind) {
        case "loaded":
          setProfileState((current) => ({ ...current, errorMessage: null, loading: false, profile: result.profile }));
          return;
        case "error":
          setProfileState((current) => ({ ...current, errorMessage: result.message, loading: false, profile: null }));
          return;
      }
    })();
    profileRefreshPromiseRef.current = refresh;
    try {
      await refresh;
    } finally {
      profileRefreshPromiseRef.current = null;
    }
  }

  async function login(): Promise<void> {
    setLoading(true);
    setToast(null);
    const response = await fetch("/api/auth/riro/login", {
      body: JSON.stringify({ id, password }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    const payload = await readLoginPayload(response);
    setLoading(false);
    if (!response.ok || !payload.user) {
      setToast(payload.errorMessage ?? "로그인에 실패했습니다.");
      return;
    }
    setUser(payload.user);
    setToast(payload.user.role === "ADMIN" ? "관리자 화면을 불러옵니다." : `${payload.user.name}님, 예약 준비 완료`);
  }

  async function logout(): Promise<void> {
    const response = await csrfFetch("/api/auth/logout", { method: "POST" });
    if (!response.ok) {
      setToast((await readApiErrorMessage(response)) ?? "로그아웃에 실패했습니다.");
      return;
    }
    resetCsrfToken();
    setUser(null);
    setPeriods([]);
    setProfileState(EMPTY_PROFILE_STATE);
    setToast("로그아웃되었습니다.");
  }

  async function requestReserve(studyPeriod: "EIGHTH" | "FIRST"): Promise<void> {
    const restrictionMessage = reservationRestrictionMessage(user);
    if (restrictionMessage) {
      setToast(restrictionMessage);
      return;
    }
    setLoading(true);
    const latestPeriods = await refreshPeriods(targetDate);
    setLoading(false);
    const period = latestPeriods.find((candidate) => candidate.studyPeriod === studyPeriod);
    if (!canReservePeriod(period)) {
      setToast("최신 좌석 수를 반영했습니다. 다시 확인하세요.");
      return;
    }
    setPendingAction({ kind: "reserve", label: period?.label ?? "예약", studyPeriod });
  }

  function requestCancel(reservationId: string): void {
    const period = periods.find((candidate) => candidate.myReservationId === reservationId);
    setPendingAction({
      kind: "cancel",
      label: period?.label ?? "예약",
      reservationId,
      restrictedUntilPreview: previewCancellationRestrictedUntil()
    });
  }

  function selectCalendarDate(date: string): void {
    if (!advancePolicy) {
      return;
    }
    if (date === advancePolicy.today) {
      setTab("today");
      return;
    }
    if (advancePolicy.kind === "available" && date >= advancePolicy.minDate && date <= advancePolicy.maxDate) {
      setAdvanceDate(date);
      setTab("advance");
    }
  }

  function selectToday(): void {
    setTab("today");
  }

  function confirmPendingAction(): void {
    const action = pendingAction;
    if (!action) {
      return;
    }
    setPendingAction(null);
    if (action.kind === "reserve") {
      void reserve(action.studyPeriod);
      return;
    }
    void cancelReservation(action.reservationId);
  }

  async function reserve(studyPeriod: "EIGHTH" | "FIRST"): Promise<void> {
    setLoading(true);
    const response = await csrfFetch("/api/reservations", {
      body: JSON.stringify({ date: targetDate, studyPeriod }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    const errorMessage = await readApiErrorMessage(response);
    if (!response.ok) {
      await refreshPeriods(targetDate);
      setLoading(false);
      setToast(errorMessage ?? "예약에 실패했습니다.");
      return;
    }
    setLoading(false);
    setToast("예약이 확정되었습니다.");
    await Promise.all([refreshPeriods(targetDate), ...(profileState.open ? [refreshProfile()] : [])]);
  }

  async function cancelReservation(reservationId: string): Promise<void> {
    setLoading(true);
    const response = await csrfFetch(`/api/reservations/${reservationId}`, { method: "DELETE" });
    const errorMessage = await readApiErrorMessage(response);
    setLoading(false);
    setToast(response.ok ? "예약이 취소되었습니다. 3일간 예약이 제한됩니다." : errorMessage ?? "예약 취소에 실패했습니다.");
    await Promise.all([
      refreshMe(),
      refreshPeriods(targetDate),
      ...(response.ok && profileState.open ? [refreshProfile()] : [])
    ]);
  }

  function openProfile(): void {
    setProfileState((current) => ({ ...current, open: true }));
    void refreshProfile();
  }

  if (isAdmin) {
    return <AdminConsole />;
  }

  return (
    <ReservationHomeView
      advanceDate={advanceDate}
      advancePolicy={advancePolicy}
      advanceUnavailable={advanceUnavailable}
      calendarPeriodsByDate={calendarPeriodsByDate}
      currentReservations={currentReservations}
      id={id}
      lastRefreshedAt={lastRefreshedAt}
      loading={loading}
      password={password}
      pendingAction={pendingAction}
      periods={periods}
      periodsRefreshing={periodsRefreshing}
      profileState={profileState}
      sidebarOpen={sidebarOpen}
      tab={tab}
      targetDate={targetDate}
      toast={toast}
      todayDate={todayDate}
      user={user}
      onAdvanceDateChange={setAdvanceDate}
      onCancel={requestCancel}
      onClosePendingAction={() => setPendingAction(null)}
      onCloseProfile={() => setProfileState((current) => ({ ...current, open: false }))}
      onConfirmPendingAction={confirmPendingAction}
      onIdChange={setId}
      onLogin={() => void login()}
      onLogout={() => void logout()}
      onOpenProfile={openProfile}
      onPasswordChange={setPassword}
      onProfileRetry={() => void refreshProfile()}
      onReserve={requestReserve}
      onSelectCalendarDate={selectCalendarDate}
      onSelectToday={selectToday}
      onSidebarToggle={() => setSidebarOpen((open) => !open)}
      onTabChange={setTab}
    />
  );
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

function canReservePeriod(period: PeriodSummary | undefined): boolean {
  return Boolean(
    period &&
      period.enabled &&
      period.myReservationId === null &&
      period.remaining > 0 &&
      period.windowState === "open"
  );
}
