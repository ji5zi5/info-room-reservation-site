import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReservationHomeView } from "../app/reservation-home-view";
import { StudentCurrentReservation } from "../lib/student-reservation-status";
import type { ReservationActionOutcome } from "./reservation-action-dialog";
import { ReservationCalendar } from "./reservation-calendar";
import { StudentReservationStatusPanel } from "./student-reservation-status-panel";

const availablePolicy = {
  kind: "available",
  maxDate: "2026-07-03",
  minDate: "2026-07-02",
  today: "2026-07-01"
} as const;

describe("ReservationCalendar", () => {
  it("renders selected dates with a quiet visual marker instead of extra status text", () => {
    const markup = renderToStaticMarkup(
      createElement(ReservationCalendar, {
        advancePolicy: availablePolicy,
        onSelectDate: noop,
        selectedDate: "2026-07-02"
      })
    );

    expect(markup).toContain("calendar-day-marker");
    expect(markup).not.toContain("calendar-selection-label");
  });
});

describe("StudentReservationStatusPanel", () => {
  it("renders current reservations as direct accessible navigation targets", () => {
    const markup = renderToStaticMarkup(
      createElement(StudentReservationStatusPanel, {
        currentReservationId: "reservation-first",
        ariaLabel: "현재 예약 상태",
        onSelectReservation: noop,
        reservations: [
          {
            date: "2026-07-02",
            label: "8면학",
            reservationId: "reservation-eighth",
            studyPeriod: "EIGHTH"
          },
          {
            date: "2026-07-03",
            label: "1면학",
            reservationId: "reservation-first",
            studyPeriod: "FIRST"
          }
        ],
        user: {
          bookingStatus: "ACTIVE",
          id: "student-1",
          restrictionReason: null,
          restrictedUntil: null,
          studentNumber: "31001"
        }
      })
    );

    expect(markup).toContain('aria-label="2026-07-02 8면학 예약 보기"');
    expect(markup).toContain('aria-label="2026-07-03 1면학 예약 보기"');
    expect(markup).toContain('aria-current="true"');
    expect(markup).not.toContain("예약 취소");
  });
});

describe("ReservationHomeView", () => {
  it("renders each current reservation as one direct navigation control", () => {
    const markup = renderToStaticMarkup(
      createElement(ReservationHomeView, {
        advancePolicy: availablePolicy,
        advanceUnavailable: false,
        currentReservations: [new StudentCurrentReservation("2026-07-02", "EIGHTH", "reservation-eighth")],
        id: "student-1",
        lastRefreshedAt: null,
        loading: false,
        onCancel: noop,
        onClosePendingAction: noop,
        onCloseProfile: noop,
        onConfirmPendingAction: async (): Promise<ReservationActionOutcome> => ({ kind: "success" }),
        onIdChange: noop,
        onLogin: noop,
        onLogout: noop,
        onOpenProfile: noop,
        onPasswordChange: noop,
        onProfileRetry: noop,
        onReserve: noop,
        onSelectCalendarDate: noop,
        onSelectCurrentReservation: noop,
        onSidebarToggle: noop,
        onTabChange: noop,
        password: "",
        pendingAction: null,
        periods: [],
        periodsRefreshing: false,
        profileState: { errorMessage: null, loading: false, open: false, profile: null },
        reservationSubmitting: false,
        sidebarOpen: true,
        tab: "advance",
        targetDate: "2026-07-02",
        toast: null,
        user: {
          bookingStatus: "ACTIVE",
          generation: 1,
          id: "student-1",
          name: "학생",
          restrictionReason: null,
          restrictedUntil: null,
          role: "STUDENT",
          studentNumber: "31001"
        }
      })
    );

    expect(markup.match(/aria-label="2026-07-02 8면학 예약 보기"/gu)).toHaveLength(1);
  });
});

function noop(): void {}
