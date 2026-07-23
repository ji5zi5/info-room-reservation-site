import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
        onConfirmPendingAction: noop,
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
        onConfirmPendingAction: noop,
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
});

function noop(): void {}
