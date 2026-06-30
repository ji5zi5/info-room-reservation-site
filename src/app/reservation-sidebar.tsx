"use client";

import {
  BadgeCheck,
  DoorOpen,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  Sparkles,
  UserRound
} from "lucide-react";
import type { ReactElement } from "react";

import { StudentReservationStatusPanel } from "@/components/student-reservation-status-panel";
import type { StudentCurrentReservation } from "@/lib/student-reservation-status";

export type ReservationSidebarUser = {
  readonly bookingStatus: string;
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly restrictionReason: string | null;
  readonly restrictedUntil: string | null;
  readonly role: string;
  readonly studentNumber: string;
};

type ReservationSidebarProps = {
  readonly currentReservations: readonly StudentCurrentReservation[];
  readonly id: string;
  readonly loading: boolean;
  readonly message: string | null;
  readonly onIdChange: (value: string) => void;
  readonly onLogin: () => void;
  readonly onLogout: () => void;
  readonly onOpenProfile: () => void;
  readonly onPasswordChange: (value: string) => void;
  readonly onToggle: () => void;
  readonly password: string;
  readonly sidebarOpen: boolean;
  readonly user: ReservationSidebarUser | null;
};

export function ReservationSidebar({
  currentReservations,
  id,
  loading,
  message,
  onIdChange,
  onLogin,
  onLogout,
  onOpenProfile,
  onPasswordChange,
  onToggle,
  password,
  sidebarOpen,
  user
}: ReservationSidebarProps): ReactElement {
  return (
    <section className="login-panel" data-open={sidebarOpen}>
      <div className="sidebar-head">
        <span className="brand-mark">
          <DoorOpen size={22} />
        </span>
        <span className="auth-mark" aria-label="인증 완료">
          <BadgeCheck size={18} />
        </span>
        <button
          aria-expanded={sidebarOpen}
          aria-label={sidebarOpen ? "왼쪽 패널 접기" : "왼쪽 패널 열기"}
          className="icon-button sidebar-toggle"
          type="button"
          onClick={onToggle}
        >
          {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
        </button>
      </div>
      <div aria-hidden={!sidebarOpen} className="sidebar-content stack">
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
              <ShieldCheck className="sidebar-user-mark" />
            </div>
            {user.role !== "ADMIN" ? (
              <button className="ghost-button" type="button" onClick={onOpenProfile}>
                <UserRound size={18} />
                프로필
              </button>
            ) : null}
            <button className="ghost-button" type="button" onClick={onLogout}>
              <LogOut size={18} />
              로그아웃
            </button>
            {message ? <p className="sidebar-message">{message}</p> : null}
            {user.role === "STUDENT" ? (
              <StudentReservationStatusPanel reservations={currentReservations} user={user} />
            ) : null}
            {user.role === "ADMIN" ? <a className="primary-button" href="/admin">관리자 화면</a> : null}
          </div>
        ) : (
          <form
            className="login-form"
            onSubmit={(event) => {
              event.preventDefault();
              onLogin();
            }}
          >
            <label className="field">
              <span>리로스쿨 ID</span>
              <input value={id} onChange={(event) => onIdChange(event.currentTarget.value)} />
            </label>
            <label className="field">
              <span>리로스쿨 PW</span>
              <input type="password" value={password} onChange={(event) => onPasswordChange(event.currentTarget.value)} />
            </label>
            <button className="primary-button" disabled={loading} type="submit">
              <Sparkles size={18} />
              {loading ? "확인 중" : "인증하기"}
            </button>
            {message ? <p className="sidebar-message">{message}</p> : null}
          </form>
        )}
      </div>
    </section>
  );
}
