import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ReservationActionOutcome } from "@/components/reservation-action-dialog";
import { ReservationHomeView } from "./reservation-home-view";
import type { ReservationSidebarUser } from "./reservation-sidebar";

const studentUser = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "student-1",
  name: "김학생",
  restrictionReason: null,
  restrictedUntil: null,
  role: "STUDENT",
  studentNumber: "31001"
} satisfies ReservationSidebarUser;

describe("ReservationHomeView", () => {
  it("uses the top-right area for student notifications instead of the decorative calendar icon", () => {
    const markup = renderToStaticMarkup(
      createElement(ReservationHomeView, {
        advancePolicy: null,
        advanceUnavailable: false,
        currentReservations: [],
        id: "",
        lastRefreshedAt: null,
        loading: false,
        onCancel: noop,
        onClosePendingAction: noop,
        onCloseProfile: noop,
        onConfirmPendingAction: noopOutcome,
        onIdChange: noop,
        onLogin: noop,
        onLogout: noop,
        onOpenProfile: noop,
        onPasswordChange: noop,
        onProfileRetry: noop,
        onReserve: noop,
        onSelectCalendarDate: noop,
        onSidebarToggle: noop,
        onTabChange: noop,
        password: "",
        pendingAction: null,
        periods: [],
        periodsRefreshing: false,
        profileState: { errorMessage: null, loading: false, open: false, profile: null },
        reservationSubmitting: false,
        sidebarOpen: true,
        tab: "today",
        targetDate: "",
        toast: null,
        user: studentUser
      })
    );

    expect(markup).toContain('aria-label="학생 알림"');
    expect(markup).not.toContain("lucide-calendar-days");
  });

  it("shows a neutral processing surface while a reservation request is pending", () => {
    const markup = renderToStaticMarkup(
      createElement(ReservationHomeView, {
        advancePolicy: null,
        advanceUnavailable: false,
        currentReservations: [],
        id: "",
        lastRefreshedAt: null,
        loading: true,
        onCancel: noop,
        onClosePendingAction: noop,
        onCloseProfile: noop,
        onConfirmPendingAction: noopOutcome,
        onIdChange: noop,
        onLogin: noop,
        onLogout: noop,
        onOpenProfile: noop,
        onPasswordChange: noop,
        onProfileRetry: noop,
        onReserve: noop,
        onSelectCalendarDate: noop,
        onSidebarToggle: noop,
        onTabChange: noop,
        password: "",
        pendingAction: null,
        periods: [],
        periodsRefreshing: false,
        profileState: { errorMessage: null, loading: false, open: false, profile: null },
        reservationSubmitting: true,
        sidebarOpen: true,
        tab: "today",
        targetDate: "",
        toast: null,
        user: studentUser
      })
    );

    expect(markup).toContain('aria-label="예약 요청 처리 중"');
    expect(markup).toContain("요청을 확인하고 있습니다.");
  });

  it("renders an active action error only in the dialog when the sidebar is collapsed", () => {
    const markup = renderToStaticMarkup(
      createElement(ReservationHomeView, {
        advancePolicy: null,
        advanceUnavailable: false,
        currentReservations: [],
        id: "",
        lastRefreshedAt: null,
        loading: false,
        onCancel: noop,
        onClosePendingAction: noop,
        onCloseProfile: noop,
        onConfirmPendingAction: noopOutcome,
        onIdChange: noop,
        onLogin: noop,
        onLogout: noop,
        onOpenProfile: noop,
        onPasswordChange: noop,
        onProfileRetry: noop,
        onReserve: noop,
        onSelectCalendarDate: noop,
        onSidebarToggle: noop,
        onTabChange: noop,
        password: "",
        pendingAction: {
          kind: "cancel",
          label: "8면학",
          reservationId: "reservation-1",
          restrictedUntilPreview: "2026-08-12T00:00:00.000Z"
        },
        periods: [],
        periodsRefreshing: false,
        profileState: { errorMessage: null, loading: false, open: false, profile: null },
        reservationSubmitting: false,
        sidebarOpen: false,
        tab: "today",
        targetDate: "",
        toast: "보류된 요청 실패",
        user: studentUser
      })
    );

    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain('class="sidebar-message"');
    expect(markup.match(/보류된 요청 실패/g)).toHaveLength(1);
  });

  it("exposes dialog-local refresh recovery only while reservation data is stale", () => {
    const staleMarkup = renderToStaticMarkup(createElement(ReservationHomeView, reservationActionViewProps(true)));
    const freshMarkup = renderToStaticMarkup(createElement(ReservationHomeView, reservationActionViewProps(false)));

    expect(staleMarkup).toContain('aria-label="다시 불러오기"');
    expect(staleMarkup).toContain('aria-busy="true"');
    expect(staleMarkup).toContain("다시 불러오는 중");
    expect(freshMarkup).not.toContain('aria-label="다시 불러오기"');
  });

  it("renders an honest disabled page retry while a stale refresh is already running", () => {
    const markup = renderToStaticMarkup(
      createElement(ReservationHomeView, {
        ...reservationActionViewProps(true),
        pendingAction: null
      })
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("다시 불러오는 중");
  });

  it("omits stale recovery controls when no retry handler exists", () => {
    const { onRefreshRetry: _onRefreshRetry, ...viewProps } = reservationActionViewProps(true);
    const markup = renderToStaticMarkup(createElement(ReservationHomeView, viewProps));

    expect(markup).not.toContain('aria-label="다시 불러오기"');
  });
});

function reservationActionViewProps(refreshError: boolean) {
  return {
    advancePolicy: null,
    advanceUnavailable: false,
    currentReservations: [],
    id: "",
    lastRefreshedAt: null,
    loading: false,
    onCancel: noop,
    onClosePendingAction: noop,
    onCloseProfile: noop,
    onConfirmPendingAction: noopOutcome,
    onIdChange: noop,
    onLogin: noop,
    onLogout: noop,
    onOpenProfile: noop,
    onPasswordChange: noop,
    onProfileRetry: noop,
    onRefreshRetry: noop,
    onReserve: noop,
    onSelectCalendarDate: noop,
    onSidebarToggle: noop,
    onTabChange: noop,
    password: "",
    pendingAction: { kind: "reserve" as const, label: "8면학", studyPeriod: "EIGHTH" as const },
    periods: [],
    periodsRefreshing: true,
    profileState: { errorMessage: null, loading: false, open: false, profile: null },
    refreshError,
    reservationSubmitting: false,
    sidebarOpen: false,
    tab: "today" as const,
    targetDate: "",
    toast: "최신 정보를 다시 불러온 뒤 확인해주세요.",
    user: studentUser
  };
}

function noop(): void {}

async function noopOutcome(): Promise<ReservationActionOutcome> {
  return { kind: "success" };
}
