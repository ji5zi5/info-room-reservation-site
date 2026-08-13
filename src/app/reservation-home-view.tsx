"use client";

import { LoaderCircle } from "lucide-react";
import { useLayoutEffect, useRef, type ReactElement } from "react";

import {
  ReservationActionDialog,
  type ReservationActionConfirmInput,
  type ReservationActionOutcome,
  type ReservationPendingAction
} from "@/components/reservation-action-dialog";
import { ReservationCalendar } from "@/components/reservation-calendar";
import { ReservationPeriodCard, type PeriodSummary } from "@/components/reservation-period-card";
import { ReservationWarningPanel } from "@/components/reservation-warning-panel";
import { StudentReservationStatusPanel } from "@/components/student-reservation-status-panel";
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
  readonly authenticationGeneration?: number;
  readonly advancePolicy: AdvanceReservationPolicy | null;
  readonly advanceUnavailable: boolean;
  readonly currentReservations: readonly StudentCurrentReservation[];
  readonly id: string;
  readonly lastRefreshedAt: string | null;
  readonly loading: boolean;
  readonly onCancel: (reservationId: string) => void;
  readonly onClosePendingAction: () => void;
  readonly onCloseProfile: () => void;
  readonly onConfirmPendingAction: (input: ReservationActionConfirmInput) => Promise<ReservationActionOutcome>;
  readonly onIdChange: (value: string) => void;
  readonly onLogin: () => void;
  readonly onLogout: () => void;
  readonly onOpenProfile: () => void;
  readonly onPasswordChange: (value: string) => void;
  readonly onProfileRetry: () => void;
  readonly onRefreshRetry?: () => void;
  readonly onReserve: (studyPeriod: "EIGHTH" | "FIRST") => void;
  readonly onSelectCalendarDate: (date: string) => void;
  readonly onSelectCurrentReservation?: (reservation: StudentCurrentReservation) => void;
  readonly onSidebarToggle: () => void;
  readonly onTabChange: (tab: ReservationHomeTab) => void;
  readonly password: string;
  readonly pendingAction: ReservationPendingAction | null;
  readonly periods: readonly PeriodSummary[];
  readonly refreshError?: boolean;
  readonly resourcesFresh?: boolean;
  readonly periodsRefreshing: boolean;
  readonly profileState: ReservationHomeProfileState;
  readonly reservationSubmitting: boolean;
  readonly selectedCurrentReservationId?: string | null;
  readonly sidebarOpen: boolean;
  readonly tab: ReservationHomeTab;
  readonly targetDate: string;
  readonly toast: string | null;
  readonly user: ReservationSidebarUser | null;
};

export function ReservationHomeView({
  authenticationGeneration = 0,
  advancePolicy,
  advanceUnavailable,
  currentReservations,
  id,
  lastRefreshedAt,
  loading,
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
  onRefreshRetry,
  onReserve,
  onSelectCalendarDate,
  onSelectCurrentReservation,
  onSidebarToggle,
  onTabChange,
  password,
  pendingAction,
  periods,
  refreshError = false,
  resourcesFresh = true,
  periodsRefreshing,
  profileState,
  reservationSubmitting,
  selectedCurrentReservationId = null,
  sidebarOpen,
  tab,
  targetDate,
  toast,
  user
}: ReservationHomeViewProps): ReactElement {
  const lastDialogActionRef = useRef<ReservationPendingAction | null>(null);
  const dialogRefreshProps = refreshError && onRefreshRetry
    ? { onRefreshRetry, refreshRetrying: periodsRefreshing }
    : {};

  useLayoutEffect(() => {
    if (pendingAction) {
      lastDialogActionRef.current = pendingAction;
      return;
    }
    const lastAction = lastDialogActionRef.current;
    if (!lastAction) {
      return;
    }
    lastDialogActionRef.current = null;
    window.requestAnimationFrame(() => {
      const buttonLabel = lastAction.kind === "reserve" ? `${lastAction.label} 예약` : "예약 취소";
      for (const card of document.querySelectorAll<HTMLElement>(".period-card")) {
        if (!card.textContent?.includes(lastAction.label)) {
          continue;
        }
        const button = Array.from(card.querySelectorAll<HTMLButtonElement>("button")).find(
          (candidate) => candidate.textContent?.trim() === buttonLabel && !candidate.disabled
        );
        button?.focus();
        return;
      }
    });
  }, [pendingAction]);

  return (
    <main className="app-shell">
      <div className="workspace" data-sidebar={sidebarOpen ? "open" : "closed"}>
        <ReservationSidebar
          currentReservations={currentReservations}
          id={id}
          loading={loading}
          message={pendingAction ? null : toast}
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
                      : refreshError
                        ? "최신 정보를 확인하지 못했습니다."
                      : lastRefreshedAt
                        ? `마지막 갱신 ${formatKstTime(lastRefreshedAt)}`
                        : "갱신 대기"}
                  </span>
                  {refreshError && onRefreshRetry ? (
                    <button
                      aria-busy={periodsRefreshing}
                      className="ghost-button"
                      disabled={periodsRefreshing}
                      type="button"
                      onClick={onRefreshRetry}
                    >
                      {periodsRefreshing ? "다시 불러오는 중" : "다시 불러오기"}
                    </button>
                  ) : null}
                </p>
              ) : null}
            </div>
            <StudentNotificationPanel authenticationGeneration={authenticationGeneration} user={user} />
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
          </div>
          {user ? (
            <StudentReservationStatusPanel
              ariaLabel="현재 예약 상태"
              currentReservationId={selectedCurrentReservationId}
              reservations={currentReservations}
              user={user}
              onSelectReservation={onSelectCurrentReservation}
            />
          ) : null}
          {advancePolicy && user ? (
            <ReservationCalendar
              advancePolicy={advancePolicy}
              selectedDate={targetDate}
              onSelectDate={onSelectCalendarDate}
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
                  actionsReady={resourcesFresh}
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
      {reservationSubmitting ? (
        <div aria-label="예약 요청 처리 중" aria-live="polite" className="reservation-processing-backdrop" role="status">
          <section className="reservation-processing-card">
            <span className="reservation-processing-spinner" aria-hidden="true">
              <LoaderCircle size={22} />
            </span>
            <strong>요청을 확인하고 있습니다.</strong>
            <p>동시 요청이 많으면 잠시 지연될 수 있습니다.</p>
          </section>
        </div>
      ) : null}
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
        errorMessage={pendingAction ? toast : null}
        loading={loading}
        onClose={onClosePendingAction}
        onConfirm={onConfirmPendingAction}
        {...dialogRefreshProps}
      />
    </main>
  );
}
