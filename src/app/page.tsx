"use client";

import {
  BadgeCheck,
  CalendarDays,
  DoorOpen,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { getAdvanceReservationPolicy } from "@/lib/advance-reservation-policy";
import { ReservationPeriodCard, type PeriodSummary } from "@/components/reservation-period-card";

type SessionUser = {
  readonly bookingStatus: string;
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly studentNumber: string;
};

type Tab = "today" | "advance";

export default function HomePage(): React.ReactElement {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [periods, setPeriods] = useState<readonly PeriodSummary[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [tab, setTab] = useState<Tab>("today");
  const [advanceDate, setAdvanceDate] = useState(() => {
    const policy = getAdvanceReservationPolicy(new Date());
    return policy.kind === "available" ? policy.minDate : policy.today;
  });
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const advancePolicy = useMemo(() => getAdvanceReservationPolicy(new Date()), []);
  const advanceUnavailable = tab === "advance" && advancePolicy.kind === "unavailable";
  const todayDate = advancePolicy.today;
  const targetDate = tab === "advance" ? advanceDate : todayDate;

  useEffect(() => {
    void refreshMe();
  }, []);

  useEffect(() => {
    if (!user) {
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
    const payload = (await response.json()) as { readonly user: SessionUser | null };
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
    const payload = (await response.json()) as { readonly error?: { readonly message: string }; readonly user?: SessionUser };
    setLoading(false);
    if (!response.ok || !payload.user) {
      setToast(payload.error?.message ?? "로그인에 실패했습니다.");
      return;
    }
    setUser(payload.user);
    setToast(`${payload.user.name}님, 예약 준비 완료`);
  }

  async function logout(): Promise<void> {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    setPeriods([]);
    setToast("로그아웃되었습니다.");
  }

  async function reserve(studyPeriod: "EIGHTH" | "FIRST"): Promise<void> {
    setLoading(true);
    const response = await fetch("/api/reservations", {
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

  return (
    <main className="app-shell">
      <div className="workspace" data-sidebar={sidebarOpen ? "open" : "closed"}>
        <section className="login-panel" data-open={sidebarOpen}>
          <div className="sidebar-head">
            <span className="brand-mark">
              <DoorOpen size={22} />
            </span>
            <span className="auth-mark" aria-label="리로스쿨 인증">
              <BadgeCheck size={18} />
            </span>
            <button
              className="icon-button sidebar-toggle"
              type="button"
              aria-expanded={sidebarOpen}
              aria-label={sidebarOpen ? "왼쪽 패널 접기" : "왼쪽 패널 열기"}
              onClick={() => setSidebarOpen((open) => !open)}
            >
              {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>
          </div>
          <div className="sidebar-content stack" aria-hidden={!sidebarOpen}>
            <div className="stack">
              <h1>정보실 예약</h1>
            </div>
            {user ? (
              <div className="stack">
                <div className="row">
                  <div>
                    <h2>{user.name}</h2>
                    <p className="muted">{user.studentNumber} · {user.role}</p>
                  </div>
                  <ShieldCheck color="#3E6AE1" />
                </div>
                <button className="ghost-button" type="button" onClick={() => void logout()}>
                  <LogOut size={18} />
                  로그아웃
                </button>
                {user.role === "ADMIN" ? <a className="primary-button" href="/admin">관리자 화면</a> : null}
              </div>
            ) : (
              <form
                className="login-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void login();
                }}
              >
                <label className="field">
                  <span>리로스쿨 ID</span>
                  <input value={id} onChange={(event) => setId(event.currentTarget.value)} />
                </label>
                <label className="field">
                  <span>리로스쿨 PW</span>
                  <input type="password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} />
                </label>
                <button className="primary-button" disabled={loading} type="submit">
                  <Sparkles size={18} />
                  {loading ? "확인 중" : "인증하기"}
                </button>
              </form>
            )}
            {toast ? <div className="toast">{toast}</div> : null}
          </div>
        </section>

        <section className="tool-panel">
          <div className="topbar">
            <div>
              <h2>예약 현황</h2>
              <p className="muted">{advanceUnavailable ? "사전예약 불가" : targetDate}</p>
            </div>
            <CalendarDays color="#3E6AE1" />
          </div>
          <div className="tabbar" aria-label="예약 종류">
            <button type="button" data-active={tab === "today"} onClick={() => setTab("today")}>당일예약</button>
            <button type="button" data-active={tab === "advance"} onClick={() => setTab("advance")}>사전예약</button>
          </div>
          {tab === "advance" && advancePolicy.kind === "available" ? (
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
          ) : null}
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
                  onReserve={(studyPeriod) => void reserve(studyPeriod)}
                />
              ))}
              {!user ? <p className="muted">예약 현황은 로그인 후 표시됩니다.</p> : null}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
