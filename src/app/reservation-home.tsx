"use client";

import { CalendarDays, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { getAdvanceReservationPolicy } from "@/lib/advance-reservation-policy";
import { buildReservationCalendarDays } from "@/lib/reservation-calendar";
import {
  collectStudentCurrentReservations,
  formatKstTime,
  previewCancellationRestrictedUntil
} from "@/lib/student-reservation-status";
import type { StudentProfilePayload } from "@/lib/student-profile";
import { ReservationPeriodCard, type PeriodSummary } from "@/components/reservation-period-card";
import { ReservationActionDialog, type ReservationPendingAction } from "@/components/reservation-action-dialog";
import { ReservationCalendar } from "@/components/reservation-calendar";
import { ReservationWarningPanel } from "@/components/reservation-warning-panel";
import { AdminConsole } from "./admin/admin-console";
import { readApiErrorMessage, readCurrentUser, readLoginPayload, readPeriodSummaries, readStudentProfilePayload } from "./client-api-response";
import { csrfFetch, resetCsrfToken } from "./csrf-fetch";
import { consumeAdminRedirectMessage, reservationRestrictionMessage } from "./reservation-home-helpers";
import { ReservationSidebar, type ReservationSidebarUser } from "./reservation-sidebar";
import { StudentProfilePanel } from "./student-profile-panel";

type Tab = "today" | "advance";
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

export function ReservationHomePage(): React.ReactElement {
  const [user, setUser] = useState<ReservationSidebarUser | null>(null);
  const [periods, setPeriods] = useState<readonly PeriodSummary[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [tab, setTab] = useState<Tab>("today");
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
  const [profileState, setProfileState] = useState<{ readonly errorMessage: string | null; readonly loading: boolean; readonly open: boolean; readonly profile: StudentProfilePayload | null }>({ errorMessage: null, loading: false, open: false, profile: null });

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
    setProfileState({ errorMessage: null, loading: false, open: false, profile: null });
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
    const latestPeriods = await refreshPeriods(targetDate);
    const period = latestPeriods.find((candidate) => candidate.studyPeriod === studyPeriod);
    if (!canReservePeriod(period)) {
      setLoading(false);
      setToast("최신 좌석 수를 반영했습니다. 다시 확인하세요.");
      return;
    }
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
    await refreshPeriods(targetDate);
    if (profileState.open) { await refreshProfile(); }
  }

  async function cancelReservation(reservationId: string): Promise<void> {
    setLoading(true);
    const response = await csrfFetch(`/api/reservations/${reservationId}`, { method: "DELETE" });
    const errorMessage = await readApiErrorMessage(response);
    setLoading(false);
    setToast(response.ok ? "예약이 취소되었습니다. 3일간 예약이 제한됩니다." : errorMessage ?? "예약 취소에 실패했습니다.");
    await refreshMe();
    await refreshPeriods(targetDate);
    if (response.ok && profileState.open) { await refreshProfile(); }
  }

  if (isAdmin) {
    return <AdminConsole />;
  }

  return (
    <main className="app-shell">
      <div className="workspace" data-sidebar={sidebarOpen ? "open" : "closed"}>
        <ReservationSidebar
          currentReservations={currentReservations}
          id={id}
          loading={loading}
          message={toast}
          password={password}
          sidebarOpen={sidebarOpen}
          user={user}
          onIdChange={setId}
          onLogin={() => void login()}
          onLogout={() => void logout()}
          onOpenProfile={() => { setProfileState((current) => ({ ...current, open: true })); void refreshProfile(); }}
          onPasswordChange={setPassword}
          onToggle={() => setSidebarOpen((open) => !open)}
        />

        <section className="tool-panel">
          <div className="topbar">
            <div>
              <h2>예약 현황</h2>
              <p className="muted">{advancePolicy ? (advanceUnavailable ? "사전예약 불가" : targetDate) : "예약 날짜 확인 중"}</p>
              {user && !advanceUnavailable ? (
                <p className="refresh-status" data-refreshing={periodsRefreshing}>
                  <span className="refresh-spinner" aria-hidden="true">
                    <LoaderCircle size={14} />
                  </span>
                  <span>
                    {periodsRefreshing
                      ? "갱신 중"
                      : lastRefreshedAt
                        ? `마지막 갱신 ${formatKstTime(lastRefreshedAt)}`
                        : "갱신 대기"}
                  </span>
                </p>
              ) : null}
            </div>
            <CalendarDays color="#3E6AE1" />
          </div>
          <div className="tabbar" aria-label="예약 종류">
            <button type="button" data-active={tab === "today"} onClick={() => setTab("today")}>당일예약</button>
            <button type="button" data-active={tab === "advance"} onClick={() => setTab("advance")}>사전예약</button>
          </div>
          {advancePolicy && user ? (
            <ReservationCalendar
              advancePolicy={advancePolicy}
              periodsByDate={calendarPeriodsByDate}
              selectedDate={targetDate}
              onSelectDate={selectCalendarDate}
              onTodayClick={selectToday}
            />
          ) : null}
          {advancePolicy ? (
            <div className="reservation-date-rail">
              {advanceUnavailable ? (
                <div className="advance-date-field advance-date-placeholder" aria-hidden="true" />
              ) : tab === "advance" && advancePolicy.kind === "available" ? (
                <label className="field advance-date-field">
                  <span>사전예약 날짜</span>
                  <input
                    max={advancePolicy.maxDate}
                    min={advancePolicy.minDate}
                    type="date"
                    value={advanceDate}
                    onChange={(event) => setAdvanceDate(event.currentTarget.value)}
                  />
                </label>
              ) : (
                <label className="field advance-date-field">
                  <span>예약 날짜</span>
                  <input disabled readOnly type="date" value={todayDate} />
                </label>
              )}
            </div>
          ) : null}
          <ReservationWarningPanel />
          {advanceUnavailable ? (
            <div className="advance-unavailable" role="status">
              <h3>사전예약 불가</h3>
              <p className="muted">금요일 이후에는 이번 주 사전예약이 마감됩니다.</p>
            </div>
          ) : (
            <div className="period-grid">
              {periods.map((period) => (
                <ReservationPeriodCard
                  key={period.studyPeriod}
                  lastRefreshedAt={lastRefreshedAt}
                  loading={loading}
                  period={period}
                  userReady={user !== null}
                  onCancel={requestCancel}
                  onReserve={requestReserve}
                />
              ))}
              {!user ? <p className="muted">예약 현황은 로그인 후 표시됩니다.</p> : null}
            </div>
          )}
        </section>
      </div>
      <StudentProfilePanel errorMessage={profileState.errorMessage} loading={profileState.loading} open={profileState.open} profile={profileState.profile} onClose={() => setProfileState((current) => ({ ...current, open: false }))} onRetry={() => void refreshProfile()} />
      <ReservationActionDialog
        action={pendingAction}
        loading={loading}
        onClose={() => setPendingAction(null)}
        onConfirm={confirmPendingAction}
      />
    </main>
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
