"use client";

import { CalendarDays } from "lucide-react";
import { useEffect, useState } from "react";

import { getAdvanceReservationPolicy } from "@/lib/advance-reservation-policy";
import { ReservationPeriodCard, type PeriodSummary } from "@/components/reservation-period-card";
import { ReservationActionDialog, type ReservationPendingAction } from "@/components/reservation-action-dialog";
import { ReservationWarningPanel } from "@/components/reservation-warning-panel";
import { AdminConsole } from "./admin/admin-console";
import { csrfFetch, resetCsrfToken } from "./csrf-fetch";
import { ReservationSidebar, type ReservationSidebarUser } from "./reservation-sidebar";

type Tab = "today" | "advance";
type AdvanceReservationPolicy = ReturnType<typeof getAdvanceReservationPolicy>;

export function ReservationHomePage(): React.ReactElement {
  const [user, setUser] = useState<ReservationSidebarUser | null>(null);
  const [periods, setPeriods] = useState<readonly PeriodSummary[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [tab, setTab] = useState<Tab>("today");
  const [advancePolicy, setAdvancePolicy] = useState<AdvanceReservationPolicy | null>(null);
  const [advanceDate, setAdvanceDate] = useState("");
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<ReservationPendingAction | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const isAdmin = user?.role === "ADMIN";
  const advanceUnavailable = tab === "advance" && advancePolicy?.kind === "unavailable";
  const todayDate = advancePolicy?.today ?? "";
  const targetDate = tab === "advance" ? advanceDate : todayDate;

  useEffect(() => {
    void refreshMe();
    const adminMessage = consumeAdminRedirectMessage();
    if (adminMessage) {
      setToast(adminMessage);
    }
  }, []);

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
  }, [advanceUnavailable, targetDate, user]);

  async function refreshMe(): Promise<void> {
    const response = await fetch("/api/me");
    const payload = (await response.json()) as { readonly user: ReservationSidebarUser | null };
    setUser(payload.user);
  }

  async function refreshPeriods(date: string): Promise<void> {
    const response = await fetch(`/api/periods?date=${date}`);
    const payload = (await response.json()) as { readonly periods: readonly PeriodSummary[] };
    setPeriods(payload.periods);
  }

  async function login(): Promise<void> {
    setLoading(true);
    setToast(null);
    const response = await fetch("/api/auth/riro/login", {
      body: JSON.stringify({ id, password }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    const payload = (await response.json()) as { readonly error?: { readonly message: string }; readonly user?: ReservationSidebarUser };
    setLoading(false);
    if (!response.ok || !payload.user) {
      setToast(payload.error?.message ?? "로그인에 실패했습니다.");
      return;
    }
    setUser(payload.user);
    setToast(payload.user.role === "ADMIN" ? "관리자 화면을 불러옵니다." : `${payload.user.name}님, 예약 준비 완료`);
  }

  async function logout(): Promise<void> {
    await csrfFetch("/api/auth/logout", { method: "POST" });
    resetCsrfToken();
    setUser(null);
    setPeriods([]);
    setToast("로그아웃되었습니다.");
  }

  function requestReserve(studyPeriod: "EIGHTH" | "FIRST"): void {
    const restrictionMessage = reservationRestrictionMessage(user);
    if (restrictionMessage) {
      setToast(restrictionMessage);
      return;
    }
    const period = periods.find((candidate) => candidate.studyPeriod === studyPeriod);
    setPendingAction({ kind: "reserve", label: period?.label ?? "예약", studyPeriod });
  }

  function requestCancel(reservationId: string): void {
    const period = periods.find((candidate) => candidate.myReservationId === reservationId);
    setPendingAction({ kind: "cancel", label: period?.label ?? "예약", reservationId });
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
    const payload = (await response.json()) as { readonly error?: { readonly message: string } };
    setLoading(false);
    if (!response.ok) {
      setToast(payload.error?.message ?? "예약에 실패했습니다.");
      return;
    }
    setToast("예약이 확정되었습니다.");
    await refreshPeriods(targetDate);
  }

  async function cancelReservation(reservationId: string): Promise<void> {
    setLoading(true);
    const response = await csrfFetch(`/api/reservations/${reservationId}`, { method: "DELETE" });
    const payload = (await response.json()) as { readonly error?: { readonly message: string } };
    setLoading(false);
    setToast(response.ok ? "예약이 취소되었습니다. 3일간 예약이 제한됩니다." : payload.error?.message ?? "예약 취소에 실패했습니다.");
    await refreshMe();
    await refreshPeriods(targetDate);
  }

  if (isAdmin) {
    return <AdminConsole />;
  }

  return (
    <main className="app-shell">
      <div className="workspace" data-sidebar={sidebarOpen ? "open" : "closed"}>
        <ReservationSidebar
          id={id}
          loading={loading}
          password={password}
          sidebarOpen={sidebarOpen}
          toast={toast}
          user={user}
          onIdChange={setId}
          onLogin={() => void login()}
          onLogout={() => void logout()}
          onPasswordChange={setPassword}
          onToggle={() => setSidebarOpen((open) => !open)}
        />

        <section className="tool-panel">
          <div className="topbar">
            <div>
              <h2>예약 현황</h2>
              <p className="muted">{advancePolicy ? (advanceUnavailable ? "사전예약 불가" : targetDate) : "예약 날짜 확인 중"}</p>
            </div>
            <CalendarDays color="#3E6AE1" />
          </div>
          <div className="tabbar" aria-label="예약 종류">
            <button type="button" data-active={tab === "today"} onClick={() => setTab("today")}>당일예약</button>
            <button type="button" data-active={tab === "advance"} onClick={() => setTab("advance")}>사전예약</button>
          </div>
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
              <p className="muted">금요일에는 이번 주 사전예약이 마감됩니다.</p>
            </div>
          ) : (
            <div className="period-grid">
              {periods.map((period) => (
                <ReservationPeriodCard
                  key={period.studyPeriod}
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
      <ReservationActionDialog
        action={pendingAction}
        loading={loading}
        onClose={() => setPendingAction(null)}
        onConfirm={confirmPendingAction}
      />
    </main>
  );
}

function consumeAdminRedirectMessage(): string | null {
  const params = new URLSearchParams(window.location.search);
  const reason = params.get("admin");
  if (reason === "required" || reason === "forbidden") {
    window.history.replaceState(null, "", window.location.pathname);
    return reason === "required" ? "로그인이 필요합니다." : "관리자 권한이 필요합니다.";
  }
  return null;
}

function reservationRestrictionMessage(user: ReservationSidebarUser | null): string | null {
  switch (user?.bookingStatus) {
    case "BANNED":
    case "RESTRICTED":
      return "예약 이용이 제한되었습니다.";
    case "ACTIVE":
    case undefined:
    default:
      return null;
  }
}
