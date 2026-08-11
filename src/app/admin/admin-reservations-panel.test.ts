import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AdminMutationResult, CancelReservationData, NoShowReservationData } from "./admin-api-client";
import { AdminReservationsPanel } from "./admin-reservations-panel";
import type { AdminReservation } from "./admin-types";

const confirmedReservation = {
  createdAt: "2026-06-16T00:00:00.000Z",
  date: "2026-06-16",
  id: "reservation-confirmed",
  reason: "학습",
  status: "CONFIRMED",
  studyPeriod: "EIGHTH",
  user: {
    bookingStatus: "ACTIVE",
    id: "student-1",
    name: "테스트학생",
    role: "STUDENT",
    studentNumber: "25001"
  }
} satisfies AdminReservation;

const mutationReservation = {
  createdAt: "2026-06-16T00:00:00.000Z",
  date: "2026-06-16",
  id: confirmedReservation.id,
  reason: confirmedReservation.reason,
  status: "CONFIRMED",
  studyPeriod: confirmedReservation.studyPeriod,
  updatedAt: "2026-06-16T00:05:00.000Z",
  userId: confirmedReservation.user.id
};

async function cancelReservationSuccess(): Promise<AdminMutationResult<CancelReservationData>> {
  return { data: { reservation: { ...mutationReservation, status: "CANCELLED" } }, kind: "ok" };
}

async function markNoShowSuccess(): Promise<AdminMutationResult<NoShowReservationData>> {
  return {
    data: {
      cancelledFutureReservationCount: 2,
      reservation: { ...mutationReservation, status: "NO_SHOW" },
      user: {
        bookingStatus: "BANNED",
        generation: 25,
        id: confirmedReservation.user.id,
        name: confirmedReservation.user.name,
        restrictedUntil: null,
        restrictionReason: "정보실 예약 노쇼",
        role: confirmedReservation.user.role,
        shadowBanProfile: "NORMAL",
        studentNumber: confirmedReservation.user.studentNumber
      }
    },
    kind: "ok"
  };
}

describe("AdminReservationsPanel", () => {
  it("renders a compact manual student reservation form", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminReservationsPanel, {
        date: "2026-06-16",
        onCancelReservation: cancelReservationSuccess,
        onCopyCsv: () => undefined,
        onMarkNoShow: markNoShowSuccess,
        onRefresh: () => undefined,
        onSelectStatus: () => undefined,
        onSetPeriod: () => undefined,
        onSetQuery: () => undefined,
        onViewUser: () => undefined,
        periodFilter: "ALL",
        query: "",
        reservations: [],
        statusFilter: "CONFIRMED"
      })
    );

    expect(markup).toContain("학생 추가");
    expect(markup).toContain("학번");
    expect(markup).toContain("시간대");
    expect(markup).toContain("사유");
    expect(markup).toContain("추가");
    expect(markup).toContain("2026-06-16");
  });

  it("exposes cancellation and no-show as accessible confirmation entry points before either mutation can run", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminReservationsPanel, {
        date: "2026-06-16",
        onCancelReservation: cancelReservationSuccess,
        onCopyCsv: () => undefined,
        onMarkNoShow: markNoShowSuccess,
        onRefresh: () => undefined,
        onSelectStatus: () => undefined,
        onSetPeriod: () => undefined,
        onSetQuery: () => undefined,
        onViewUser: () => undefined,
        periodFilter: "ALL",
        query: "",
        reservations: [confirmedReservation],
        statusFilter: "CONFIRMED"
      })
    );

    expect(markup).toMatch(/<button(?=[^>]*aria-haspopup="dialog")[^>]*>[\s\S]*?취소[\s\S]*?<\/button>/u);
    expect(markup).toMatch(/<button(?=[^>]*aria-haspopup="dialog")[^>]*>[\s\S]*?노쇼[\s\S]*?<\/button>/u);
  });

  it("renders the existing cancellation dialog for a dedicated deep-link handoff outside the visible list", () => {
    // Given / When
    const markup = renderToStaticMarkup(
      createElement(AdminReservationsPanel, {
        date: "2026-06-16",
        onCancelReservation: cancelReservationSuccess,
        onCopyCsv: () => undefined,
        onMarkNoShow: markNoShowSuccess,
        onRefresh: () => undefined,
        onSelectStatus: () => undefined,
        onSetPeriod: () => undefined,
        onSetQuery: () => undefined,
        onViewUser: () => undefined,
        periodFilter: "ALL",
        query: "cannot-find-target",
        requestedCancellation: confirmedReservation,
        reservations: [],
        statusFilter: "CONFIRMED"
      })
    );

    // Then
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("예약을 관리자 취소할까요?");
    expect(markup).toContain(confirmedReservation.user.name);
    expect(markup).toContain(confirmedReservation.date);
  });
});
