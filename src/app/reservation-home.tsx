"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getAdvanceReservationPolicy, isSelectableAdvanceDate } from "@/lib/advance-reservation-policy";
import { collectStudentCurrentReservations, previewCancellationRestrictedUntil } from "@/lib/student-reservation-status";
import type { ReservationActionConfirmInput, ReservationPendingAction } from "@/components/reservation-action-dialog";
import { AdminConsole } from "./admin/admin-console";
import { readApiErrorMessage, readCurrentUser, readLoginPayload, readStudentProfilePayload } from "./client-api-response";
import { csrfFetch, resetCsrfToken } from "./csrf-fetch";
import { consumeAdminRedirectMessage, reservationRestrictionMessage } from "./reservation-home-helpers";
import { canReservePeriod } from "./reservation-home-reservation-rules";
import { useReservationPeriodRefresh } from "./reservation-home-period-refresh";
import { ReservationHomeView, type ReservationHomeProfileState, type ReservationHomeTab } from "./reservation-home-view";
import type { ReservationSidebarUser } from "./reservation-sidebar";

type AdvanceReservationPolicy = ReturnType<typeof getAdvanceReservationPolicy>;

const EMPTY_PROFILE_STATE: ReservationHomeProfileState = { errorMessage: null, loading: false, open: false, profile: null };
const COMPACT_RESERVATION_VIEW_QUERY = "(max-width: 850px)";

function isCompactReservationView(): boolean {
  return typeof window !== "undefined" && window.matchMedia(COMPACT_RESERVATION_VIEW_QUERY).matches;
}

export function ReservationHomePage(): React.ReactElement {
  const [user, setUser] = useState<ReservationSidebarUser | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [tab, setTab] = useState<ReservationHomeTab>("today");
  const [advancePolicy, setAdvancePolicy] = useState<AdvanceReservationPolicy | null>(null);
  const [advanceDate, setAdvanceDate] = useState("");
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<ReservationPendingAction | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const profileRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const [profileState, setProfileState] = useState<ReservationHomeProfileState>(EMPTY_PROFILE_STATE);

  const refreshMe = useCallback(async (): Promise<void> => {
    const response = await fetch("/api/me");
    setUser(await readCurrentUser(response));
  }, []);

  const isAdmin = user?.role === "ADMIN";
  const advanceUnavailable = tab === "advance" && advancePolicy?.kind === "unavailable";
  const todayDate = advancePolicy?.today ?? "";
  const targetDate = tab === "advance" ? advanceDate : todayDate;
  const { calendarPeriodsByDate, clearPeriods, lastRefreshedAt, periods, periodsRefreshing, refreshPeriods } =
    useReservationPeriodRefresh({
      advancePolicy,
      advanceUnavailable,
      refreshMe,
      targetDate,
      user
    });
  const currentReservations = collectStudentCurrentReservations(calendarPeriodsByDate);

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
    if (user && user.role !== "ADMIN" && isCompactReservationView()) {
      setSidebarOpen(false);
    }
  }, [user?.id, user?.role]);

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
    if (payload.user.role !== "ADMIN" && isCompactReservationView()) {
      setSidebarOpen(false);
    }
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
    clearPeriods();
    setProfileState(EMPTY_PROFILE_STATE);
    setToast("로그아웃되었습니다.");
  }

  async function requestReserve(studyPeriod: "EIGHTH" | "FIRST"): Promise<void> {
    const restrictionMessage = reservationRestrictionMessage(user);
    if (restrictionMessage) {
      setToast(restrictionMessage);
      return;
    }
    const period = (await refreshPeriods(targetDate)).find((candidate) => candidate.studyPeriod === studyPeriod);
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

  function changeAdvanceDate(date: string): void {
    if (advancePolicy && isSelectableAdvanceDate(date, advancePolicy)) {
      setAdvanceDate(date);
    }
  }

  function selectCalendarDate(date: string): void {
    if (!advancePolicy) {
      return;
    }
    if (date === advancePolicy.today) {
      setTab("today");
      return;
    }
    if (isSelectableAdvanceDate(date, advancePolicy)) {
      setAdvanceDate(date);
      setTab("advance");
    }
  }

  function selectToday(): void {
    setTab("today");
  }

  function confirmPendingAction(input: ReservationActionConfirmInput): void {
    const action = pendingAction;
    if (!action) {
      return;
    }
    setPendingAction(null);
    if (action.kind === "reserve") {
      if (input.kind !== "reserve") {
        return;
      }
      void reserve(action.studyPeriod, input.reason);
      return;
    }
    if (input.kind !== "cancel") {
      return;
    }
    void cancelReservation(action.reservationId);
  }

  async function reserve(studyPeriod: "EIGHTH" | "FIRST", reason: string): Promise<void> {
    setLoading(true);
    const response = await csrfFetch("/api/reservations", {
      body: JSON.stringify({ date: targetDate, reason, studyPeriod }),
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
      user={user}
      onAdvanceDateChange={changeAdvanceDate}
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
