"use client";

import { LoaderCircle } from "lucide-react";
import type { ReactElement } from "react";

import {
  ReservationActionDialog,
  type ReservationActionConfirmInput,
  type ReservationPendingAction
} from "@/components/reservation-action-dialog";
import { ReservationCalendar } from "@/components/reservation-calendar";
import { ReservationPeriodCard, type PeriodSummary } from "@/components/reservation-period-card";
import { ReservationWarningPanel } from "@/components/reservation-warning-panel";
import type { getAdvanceReservationPolicy } from "@/lib/advance-reservation-policy";
import type { StudentCurrentReservation } from "@/lib/student-reservation-status";
import { formatKstTime } from "@/lib/student-reservation-status";
import type { StudentProfilePayload } from "@/lib/student-profile";
import { ReservationSidebar, type ReservationSidebarUser } from "./reservation-sidebar";
import { StudentNotificationPanel } from "./student-notification-panel";
import { StudentProfilePanel } from "./student-profile-panel";

export type ReservationHomeTab = "today" | "advance";

export type ReservationHomeProfileState = {
  readonly errorMessage: string | null;
  readonly loading: boolean;
  readonly open: boolean;
  readonly profile: StudentProfilePayload | null;
};

type AdvanceReservationPolicy = ReturnType<typeof getAdvanceReservationPolicy>;

type ReservationHomeViewProps = {
  readonly advanceDate: string;
  readonly advancePolicy: AdvanceReservationPolicy | null;
  readonly advanceUnavailable: boolean;
  readonly currentReservations: readonly StudentCurrentReservation[];
  readonly id: string;
  readonly lastRefreshedAt: string | null;
  readonly loading: boolean;
  readonly onAdvanceDateChange: (value: string) => void;
  readonly onCancel: (reservationId: string) => void;
  readonly onClosePendingAction: () => void;
  readonly onCloseProfile: () => void;
  readonly onConfirmPendingAction: (input: ReservationActionConfirmInput) => void;
  readonly onIdChange: (value: string) => void;
  readonly onLogin: () => void;
  readonly onLogout: () => void;
  readonly onOpenProfile: () => void;
  readonly onPasswordChange: (value: string) => void;
  readonly onProfileRetry: () => void;
  readonly onReserve: (studyPeriod: "EIGHTH" | "FIRST") => void;
  readonly onSelectCalendarDate: (date: string) => void;
  readonly onSelectToday: () => void;
  readonly onSidebarToggle: () => void;
  readonly onTabChange: (tab: ReservationHomeTab) => void;
  readonly password: string;
  readonly pendingAction: ReservationPendingAction | null;
  readonly periods: readonly PeriodSummary[];
  readonly periodsRefreshing: boolean;
  readonly profileState: ReservationHomeProfileState;
  readonly sidebarOpen: boolean;
  readonly tab: ReservationHomeTab;
  readonly targetDate: string;
  readonly toast: string | null;
  readonly user: ReservationSidebarUser | null;
};

export function ReservationHomeView({
  advanceDate,
  advancePolicy,
  advanceUnavailable,
  currentReservations,
  id,
  lastRefreshedAt,
  loading,
  onAdvanceDateChange,
  onCancel,
  onClosePendingAction,
  onCloseProfile,
  onConfirmPendingAction,
  onIdChange,
  onLogin,
  onLogout,
  onOpenProfile,
  onPasswordChange,
  onProfileRetry,
  onReserve,
  onSelectCalendarDate,
  onSelectToday,
  onSidebarToggle,
  onTabChange,
  password,
  pendingAction,
  periods,
  periodsRefreshing,
  profileState,
  sidebarOpen,
  tab,
  targetDate,
  toast,
  user
}: ReservationHomeViewProps): ReactElement {
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
          onIdChange={onIdChange}
          onLogin={onLogin}
          onLogout={onLogout}
          onOpenProfile={onOpenProfile}
          onPasswordChange={onPasswordChange}
          onToggle={onSidebarToggle}
        />

        <section className="tool-panel">
          <div className="topbar">
            <div>
              <h2>예약 현황</h2>
              <p className="muted">
                {advancePolicy ? (advanceUnavailable ? "사전예약 불가" : targetDate) : "예약 날짜 확인 중"}
              </p>
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
            <StudentNotificationPanel user={user} />
          </div>
          <div className="reservation-mode-row">
            <div className="tabbar" aria-label="예약 종류">
              <button type="button" data-active={tab === "today"} onClick={() => onTabChange("today")}>
                당일예약
              </button>
              <button type="button" data-active={tab === "advance"} onClick={() => onTabChange("advance")}>
                사전예약
              </button>
            </div>
            {advancePolicy && tab === "advance" && advancePolicy.kind === "available" && !advanceUnavailable ? (
              <div className="reservation-date-rail">
                <label className="field advance-date-field">
                  <span>사전예약 날짜</span>
                  <input
                    max={advancePolicy.maxDate}
                    min={advancePolicy.minDate}
                    type="date"
                    value={advanceDate}
                    onChange={(event) => onAdvanceDateChange(event.currentTarget.value)}
                  />
                </label>
              </div>
            ) : null}
          </div>
          {advancePolicy && user ? (
            <ReservationCalendar
              advancePolicy={advancePolicy}
              selectedDate={targetDate}
              onSelectDate={onSelectCalendarDate}
              onTodayClick={onSelectToday}
            />
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
                  loading={loading}
                  period={period}
                  userReady={user !== null}
                  onCancel={onCancel}
                  onReserve={onReserve}
                />
              ))}
              {!user ? <p className="muted">예약 현황은 로그인 후 표시됩니다.</p> : null}
            </div>
          )}
        </section>
      </div>
      <footer className="site-credit" aria-label="사이트 크레딧">
        © 2026 ISHS 32nd · 엄지오
      </footer>
      <StudentProfilePanel
        errorMessage={profileState.errorMessage}
        loading={profileState.loading}
        open={profileState.open}
        profile={profileState.profile}
        onClose={onCloseProfile}
        onRetry={onProfileRetry}
      />
      <ReservationActionDialog
        action={pendingAction}
        loading={loading}
        onClose={onClosePendingAction}
        onConfirm={onConfirmPendingAction}
      />
    </main>
  );
}
